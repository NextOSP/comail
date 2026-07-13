//! Thin wrapper around async-imap. Everything the sync engine needs goes
//! through `ImapSession`, so async-imap API churn stays contained here.
//!
//! v1 keeps the protocol surface small: no CONDSTORE/QRESYNC - incremental
//! sync is done with new-UID fetches, windowed flag polls, and UID-set
//! reconciliation, which is correct on every server.

use crate::error::{CoreError, Result};
use futures::StreamExt;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

// async-imap with runtime-tokio speaks tokio's AsyncRead/AsyncWrite natively.
pub type ImapStream = tokio_rustls::client::TlsStream<TcpStream>;
pub type Session = async_imap::Session<ImapStream>;

/// Dev/self-hosted escape hatch: COMAIL_TLS_INSECURE=1 disables certificate
/// verification (e.g. self-signed Dovecot). Off by default; never set it for
/// real accounts.
pub fn tls_insecure() -> bool {
    std::env::var("COMAIL_TLS_INSECURE")
        .map(|v| v == "1")
        .unwrap_or(false)
}

#[derive(Debug)]
struct NoVerify(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> std::result::Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

pub fn tls_connector() -> TlsConnector {
    static CONFIG: once_cell::sync::Lazy<Arc<rustls::ClientConfig>> =
        once_cell::sync::Lazy::new(|| {
            // Multiple rustls backends may be enabled via the dependency
            // graph; pick ring explicitly so there's always a default.
            let _ = rustls::crypto::ring::default_provider().install_default();
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let mut config = rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth();
            if tls_insecure() {
                tracing::warn!("COMAIL_TLS_INSECURE=1: TLS certificate verification is DISABLED");
                let provider = rustls::crypto::CryptoProvider::get_default()
                    .cloned()
                    .unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));
                config
                    .dangerous()
                    .set_certificate_verifier(Arc::new(NoVerify(provider)));
            }
            Arc::new(config)
        });
    TlsConnector::from(CONFIG.clone())
}

#[derive(Clone)]
pub enum ImapCredentials {
    Password { user: String, password: String },
    XOAuth2 { user: String, access_token: String },
}

struct XOAuth2Authenticator {
    response: String,
    /// The initial client response is sent exactly once. Any further challenge
    /// is the server's SASL *error* response, which must be answered per RFC.
    sent_initial: bool,
}

impl async_imap::Authenticator for XOAuth2Authenticator {
    type Response = String;
    fn process(&mut self, challenge: &[u8]) -> Self::Response {
        if !self.sent_initial {
            // First challenge (empty `+`): send the base64 XOAUTH2 credential.
            self.sent_initial = true;
            return self.response.clone();
        }
        // Auth failed: the server sent an error challenge (a base64 JSON blob
        // like {"status":"...","schemes":"Bearer",...}). Per SASL XOAUTH2
        // (RFC 7628) the client MUST reply with an EMPTY response so the server
        // can emit the tagged `NO <reason>`. Echoing the credential again makes
        // Gmail/Outlook keep issuing error challenges, deadlocking the exchange
        // until the socket times out (the "sync never starts" hang).
        tracing::warn!(
            challenge = %String::from_utf8_lossy(challenge),
            "imap xoauth2: server rejected token; replying empty to surface the error"
        );
        String::new()
    }
}

pub async fn connect(host: &str, port: u16, creds: ImapCredentials) -> Result<Session> {
    // Bound the whole handshake so a silent stall (server never sends the
    // greeting, or an AUTHENTICATE that never gets a tagged response) surfaces
    // as an error instead of hanging the sync actor forever.
    const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
    tokio::time::timeout(CONNECT_TIMEOUT, connect_inner(host, port, creds))
        .await
        .map_err(|_| {
            tracing::warn!(%host, port, "imap connect: timed out after 30s");
            CoreError::Imap(format!("connect {host}:{port}: timed out"))
        })?
}

async fn connect_inner(host: &str, port: u16, creds: ImapCredentials) -> Result<Session> {
    tracing::debug!(%host, port, "imap connect: opening TCP");
    let tcp = TcpStream::connect((host, port))
        .await
        .map_err(|e| CoreError::Imap(format!("connect {host}:{port}: {e}")))?;
    tcp.set_nodelay(true).ok();
    let server_name = rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|e| CoreError::Tls(e.to_string()))?;
    tracing::debug!(%host, "imap connect: TCP up, starting TLS");
    let tls = tls_connector()
        .connect(server_name, tcp)
        .await
        .map_err(|e| CoreError::Tls(e.to_string()))?;
    tracing::debug!(%host, "imap connect: TLS up, reading greeting");
    let mut client = async_imap::Client::new(tls);
    // async-imap requires the caller to consume the server greeting before
    // issuing any command. Skipping it leaves `* OK ...ready` in the buffer,
    // which the login/AUTHENTICATE handshake then reads in place of the real
    // tagged/continuation response - desyncing the exchange so it hangs until
    // the socket times out (the "stuck Offline, never syncs" bug).
    match client.read_response().await {
        Ok(Some(greeting)) => {
            tracing::debug!(%host, greeting = ?greeting.parsed(), "imap connect: greeting received, authenticating");
        }
        Ok(None) => {
            return Err(CoreError::Imap(format!(
                "{host}: connection closed before IMAP greeting"
            )))
        }
        Err(e) => return Err(CoreError::Imap(format!("{host}: reading greeting: {e}"))),
    }

    let session = match creds {
        ImapCredentials::Password { user, password } => client
            .login(&user, &password)
            .await
            .map_err(|(e, _)| CoreError::Auth(format!("imap login: {e}")))?,
        ImapCredentials::XOAuth2 { user, access_token } => {
            let auth = XOAuth2Authenticator {
                response: crate::oauth::xoauth2::raw_response(&user, &access_token),
                sent_initial: false,
            };
            client
                .authenticate("XOAUTH2", auth)
                .await
                .map_err(|(e, _)| CoreError::Auth(format!("imap xoauth2: {e}")))?
        }
    };
    tracing::debug!(%host, "imap connect: authenticated");
    Ok(session)
}

#[derive(Debug, Clone)]
pub struct RemoteFolder {
    pub name: String,
    pub delimiter: Option<String>,
    /// Lowercased attributes, e.g. "\\sent", "\\noselect".
    pub attributes: Vec<String>,
}

pub async fn list_folders(session: &mut Session) -> Result<Vec<RemoteFolder>> {
    let mut out = Vec::new();
    {
        let mut stream = session
            .list(Some(""), Some("*"))
            .await
            .map_err(|e| CoreError::Imap(e.to_string()))?;
        while let Some(item) = stream.next().await {
            let name = item.map_err(|e| CoreError::Imap(e.to_string()))?;
            let attributes = name
                .attributes()
                .iter()
                .map(|a| format!("{a:?}").to_lowercase())
                .collect();
            out.push(RemoteFolder {
                name: name.name().to_string(),
                delimiter: name.delimiter().map(|d| d.to_string()),
                attributes,
            });
        }
    }
    Ok(out)
}

#[derive(Debug, Clone)]
pub struct SelectedFolder {
    pub uid_validity: Option<i64>,
    pub uid_next: Option<i64>,
    pub exists: u32,
}

pub async fn select(session: &mut Session, folder: &str) -> Result<SelectedFolder> {
    let mb = session
        .select(folder)
        .await
        .map_err(|e| CoreError::Imap(e.to_string()))?;
    Ok(SelectedFolder {
        uid_validity: mb.uid_validity.map(|v| v as i64),
        uid_next: mb.uid_next.map(|v| v as i64),
        exists: mb.exists,
    })
}

#[derive(Debug, Clone, Default)]
pub struct FetchedFlags {
    pub seen: bool,
    pub flagged: bool,
    pub draft: bool,
    pub deleted: bool,
    /// Custom IMAP keywords (used to round-trip user labels).
    pub keywords: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct FetchedHeader {
    pub uid: u32,
    pub flags: FetchedFlags,
    pub internal_date_ms: Option<i64>,
    pub size: Option<u32>,
    pub header_bytes: Vec<u8>,
    /// Derived from BODYSTRUCTURE so the list can flag attachments before the
    /// full body is ever downloaded.
    pub has_attachments: bool,
}

/// Walk a BODYSTRUCTURE for any part disposed as an attachment. Inline parts
/// (signature logos, embedded images) use "inline" and are ignored, so this is
/// a truer "has a file" signal than counting every non-body MIME part.
fn bodystructure_has_attachment(bs: &async_imap::imap_proto::BodyStructure) -> bool {
    use async_imap::imap_proto::BodyStructure as Bs;
    let is_attachment = |common: &async_imap::imap_proto::BodyContentCommon| {
        common
            .disposition
            .as_ref()
            .is_some_and(|d| d.ty.eq_ignore_ascii_case("attachment"))
    };
    match bs {
        Bs::Multipart { bodies, .. } => bodies.iter().any(bodystructure_has_attachment),
        Bs::Basic { common, .. } | Bs::Text { common, .. } | Bs::Message { common, .. } => {
            is_attachment(common)
        }
    }
}

fn flags_of(fetch: &async_imap::types::Fetch) -> FetchedFlags {
    let mut f = FetchedFlags::default();
    for flag in fetch.flags() {
        match flag {
            async_imap::types::Flag::Seen => f.seen = true,
            async_imap::types::Flag::Flagged => f.flagged = true,
            async_imap::types::Flag::Draft => f.draft = true,
            async_imap::types::Flag::Deleted => f.deleted = true,
            async_imap::types::Flag::Custom(name) => f.keywords.push(name.to_string()),
            _ => {}
        }
    }
    f
}

const HEADER_FIELDS: &str = "BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES SUBJECT FROM TO CC BCC DATE LIST-ID LIST-UNSUBSCRIBE PRECEDENCE AUTO-SUBMITTED)]";

/// Fetch envelope headers + flags for a UID set (e.g. "100:200" or "5,7,9").
pub async fn fetch_headers(session: &mut Session, uid_set: &str) -> Result<Vec<FetchedHeader>> {
    let query = format!("(UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE {HEADER_FIELDS})");
    let mut out = Vec::new();
    {
        let mut stream = session
            .uid_fetch(uid_set, &query)
            .await
            .map_err(|e| CoreError::Imap(e.to_string()))?;
        while let Some(item) = stream.next().await {
            let fetch = item.map_err(|e| CoreError::Imap(e.to_string()))?;
            let Some(uid) = fetch.uid else { continue };
            out.push(FetchedHeader {
                uid,
                flags: flags_of(&fetch),
                internal_date_ms: fetch.internal_date().map(|d| d.timestamp_millis()),
                size: fetch.size,
                header_bytes: fetch.header().map(|h| h.to_vec()).unwrap_or_default(),
                has_attachments: fetch
                    .bodystructure()
                    .is_some_and(bodystructure_has_attachment),
            });
        }
    }
    Ok(out)
}

/// Fetch flags only, for a UID window (change detection without CONDSTORE).
pub async fn fetch_flags(session: &mut Session, uid_set: &str) -> Result<Vec<(u32, FetchedFlags)>> {
    let mut out = Vec::new();
    {
        let mut stream = session
            .uid_fetch(uid_set, "(UID FLAGS)")
            .await
            .map_err(|e| CoreError::Imap(e.to_string()))?;
        while let Some(item) = stream.next().await {
            let fetch = item.map_err(|e| CoreError::Imap(e.to_string()))?;
            if let Some(uid) = fetch.uid {
                out.push((uid, flags_of(&fetch)));
            }
        }
    }
    Ok(out)
}

/// Full raw RFC 5322 bytes of one message.
pub async fn fetch_full(session: &mut Session, uid: u32) -> Result<Option<Vec<u8>>> {
    let mut body = None;
    {
        let mut stream = session
            .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
            .await
            .map_err(|e| CoreError::Imap(e.to_string()))?;
        while let Some(item) = stream.next().await {
            let fetch = item.map_err(|e| CoreError::Imap(e.to_string()))?;
            if let Some(b) = fetch.body() {
                body = Some(b.to_vec());
            }
        }
    }
    Ok(body)
}

/// Full raw bytes for a whole UID set in a single FETCH round-trip, returned as
/// (uid, bytes) pairs. Backfill fetches bodies in bulk this way: one command
/// for a chunk of messages instead of one round-trip per message.
pub async fn fetch_full_batch(
    session: &mut Session,
    uid_set: &str,
) -> Result<Vec<(u32, Vec<u8>)>> {
    let mut out = Vec::new();
    {
        let mut stream = session
            .uid_fetch(uid_set, "(UID BODY.PEEK[])")
            .await
            .map_err(|e| CoreError::Imap(e.to_string()))?;
        while let Some(item) = stream.next().await {
            let fetch = item.map_err(|e| CoreError::Imap(e.to_string()))?;
            if let (Some(uid), Some(b)) = (fetch.uid, fetch.body()) {
                out.push((uid, b.to_vec()));
            }
        }
    }
    Ok(out)
}

/// All UIDs currently in the selected folder (for expunge reconciliation).
pub async fn uid_search_all(session: &mut Session) -> Result<Vec<u32>> {
    let set = session
        .uid_search("ALL")
        .await
        .map_err(|e| CoreError::Imap(e.to_string()))?;
    let mut v: Vec<u32> = set.into_iter().collect();
    v.sort_unstable();
    Ok(v)
}

pub async fn uid_search_since(session: &mut Session, date: chrono::NaiveDate) -> Result<Vec<u32>> {
    // IMAP date format: 1-Jan-2024
    let q = format!("SINCE {}", date.format("%-d-%b-%Y"));
    let set = session
        .uid_search(&q)
        .await
        .map_err(|e| CoreError::Imap(e.to_string()))?;
    let mut v: Vec<u32> = set.into_iter().collect();
    v.sort_unstable();
    Ok(v)
}

pub async fn store_flag(session: &mut Session, uid: u32, flag: &str, add: bool) -> Result<()> {
    let op = if add { "+FLAGS" } else { "-FLAGS" };
    let mut stream = session
        .uid_store(uid.to_string(), format!("{op} ({flag})"))
        .await
        .map_err(|e| CoreError::Imap(e.to_string()))?;
    while let Some(item) = stream.next().await {
        item.map_err(|e| CoreError::Imap(e.to_string()))?;
    }
    Ok(())
}

/// MOVE if the server supports it, else COPY + \Deleted + EXPUNGE.
pub async fn uid_move(session: &mut Session, uid: u32, target: &str) -> Result<()> {
    match session.uid_mv(uid.to_string(), target).await {
        Ok(()) => Ok(()),
        Err(_) => {
            session
                .uid_copy(uid.to_string(), target)
                .await
                .map_err(|e| CoreError::Imap(e.to_string()))?;
            store_flag(session, uid, "\\Deleted", true).await?;
            let stream = session
                .expunge()
                .await
                .map_err(|e| CoreError::Imap(e.to_string()))?;
            futures::pin_mut!(stream);
            while let Some(item) = stream.next().await {
                item.map_err(|e| CoreError::Imap(e.to_string()))?;
            }
            Ok(())
        }
    }
}

pub async fn append(session: &mut Session, folder: &str, raw: &[u8], seen: bool) -> Result<()> {
    let flags = if seen { Some("(\\Seen)") } else { None };
    session
        .append(folder, flags, None, raw)
        .await
        .map_err(|e| CoreError::Imap(e.to_string()))?;
    Ok(())
}

pub async fn create_folder(session: &mut Session, name: &str) -> Result<()> {
    session
        .create(name)
        .await
        .map_err(|e| CoreError::Imap(e.to_string()))
}

/// Expunge all \Deleted messages in the selected folder.
pub async fn expunge_all(session: &mut Session) -> Result<()> {
    let stream = session
        .expunge()
        .await
        .map_err(|e| CoreError::Imap(e.to_string()))?;
    futures::pin_mut!(stream);
    while let Some(item) = stream.next().await {
        item.map_err(|e| CoreError::Imap(e.to_string()))?;
    }
    Ok(())
}

pub async fn noop(session: &mut Session) -> Result<()> {
    session
        .noop()
        .await
        .map_err(|e| CoreError::Imap(e.to_string()))
}

pub async fn logout(mut session: Session) {
    let _ = session.logout().await;
}

/// Whether the server advertises the IDLE extension (RFC 2177). Issues a
/// CAPABILITY command; callers cache the result for the connection's lifetime.
pub async fn supports_idle(session: &mut Session) -> Result<bool> {
    let caps = session
        .capabilities()
        .await
        .map_err(|e| CoreError::Imap(e.to_string()))?;
    Ok(caps.has_str("IDLE"))
}

/// Why an `idle_wait` returned. Generic over the actor's command type `C` so
/// this module stays free of any `sync::engine` dependency.
pub enum IdleOutcome<C> {
    /// The server pushed unsolicited data (likely new mail): run a sync.
    Activity,
    /// The max-idle cap elapsed with no activity: run a sync as a backstop.
    Timeout,
    /// A command arrived on the actor channel; hand it back to the caller.
    Command(C),
    /// The command channel closed (sender dropped): caller should shut down.
    ChannelClosed,
}

/// Enter IDLE on the currently-selected mailbox and wait until the server
/// reports activity, `max` elapses, or a command arrives on `rx` — whichever
/// comes first. Always leaves IDLE (`DONE`) on the happy path so the returned
/// session is reusable. On any IMAP/IO error the session is consumed and `Err`
/// is returned; the caller must reconnect.
pub async fn idle_wait<C>(
    session: Session,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<C>,
    max: std::time::Duration,
) -> Result<(Session, IdleOutcome<C>)> {
    use async_imap::extensions::idle::IdleResponse;

    let mut idle = session.idle();
    idle.init()
        .await
        .map_err(|e| CoreError::Imap(e.to_string()))?;

    // The wait future borrows `idle` mutably and `done()` consumes it, so the
    // future and its StopSource must live only inside this block and be dropped
    // before we call `done()`. `_stop` is named (not a bare `_`) so it is NOT
    // dropped early — dropping it would interrupt the wait immediately.
    let outcome = {
        let (wait_fut, _stop) = idle.wait_with_timeout(max);
        tokio::pin!(wait_fut);
        tokio::select! {
            res = &mut wait_fut => match res {
                Ok(IdleResponse::NewData(_)) => IdleOutcome::Activity,
                // We interrupt via `rx.recv()`, not the StopSource, so a
                // ManualInterrupt here is unexpected; treat it as a backstop.
                Ok(IdleResponse::Timeout) | Ok(IdleResponse::ManualInterrupt) => IdleOutcome::Timeout,
                // Connection broke mid-IDLE: don't attempt DONE on a dead
                // socket. Dropping `idle` closes it; the caller reconnects.
                Err(e) => return Err(CoreError::Imap(e.to_string())),
            },
            cmd = rx.recv() => match cmd {
                Some(c) => IdleOutcome::Command(c),
                None => IdleOutcome::ChannelClosed,
            },
        }
    };

    // Leave IDLE. Bound DONE so a server that never acks can't wedge the actor.
    let session = match tokio::time::timeout(std::time::Duration::from_secs(10), idle.done()).await {
        Ok(r) => r.map_err(|e| CoreError::Imap(e.to_string()))?,
        Err(_) => return Err(CoreError::Imap("IDLE DONE timed out".into())),
    };
    Ok((session, outcome))
}

/// Compress a sorted UID list into an IMAP set string ("1:5,8,10:12").
pub fn uid_set(uids: &[u32]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut i = 0;
    while i < uids.len() {
        let start = uids[i];
        let mut end = start;
        while i + 1 < uids.len() && uids[i + 1] == end + 1 {
            i += 1;
            end = uids[i];
        }
        if start == end {
            parts.push(start.to_string());
        } else {
            parts.push(format!("{start}:{end}"));
        }
        i += 1;
    }
    parts.join(",")
}

#[cfg(test)]
mod tests {
    #[test]
    fn uid_set_compresses() {
        assert_eq!(super::uid_set(&[1, 2, 3, 5, 7, 8]), "1:3,5,7:8");
        assert_eq!(super::uid_set(&[]), "");
        assert_eq!(super::uid_set(&[42]), "42");
    }
}
