//! Thin wrapper around async-imap. Everything the sync engine needs goes
//! through `ImapSession`, so async-imap API churn stays contained here.
//!
//! v1 keeps the protocol surface small: no CONDSTORE/QRESYNC - incremental
//! sync is done with new-UID fetches, windowed flag polls, and UID-set
//! reconciliation, which is correct on every server.

use crate::error::{CoreError, Result};
use crate::mime::{self, MimePlan};
use futures::StreamExt;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

// async-imap with runtime-tokio speaks tokio's AsyncRead/AsyncWrite natively.
pub type ImapStream = tokio_rustls::client::TlsStream<TcpStream>;
pub type Session = async_imap::Session<ImapStream>;

/// Metadata and mutation commands must never be able to wedge a sync actor.
pub const METADATA_TIMEOUT: Duration = Duration::from_secs(30);
/// Background message-content reads are allowed a little longer, but remain
/// bounded so a throttled server cannot pin a worker forever.
pub const CONTENT_TIMEOUT: Duration = Duration::from_secs(60);
/// User-requested attachment reads may be large and get a larger deadline.
pub const ATTACHMENT_TIMEOUT: Duration = Duration::from_secs(120);

async fn with_deadline<T, F>(label: &'static str, timeout: Duration, future: F) -> Result<T>
where
    F: Future<Output = Result<T>>,
{
    tokio::time::timeout(timeout, future).await.map_err(|_| {
        tracing::warn!(
            operation = label,
            seconds = timeout.as_secs(),
            "imap operation timed out"
        );
        CoreError::Imap(format!("{label} timed out after {}s", timeout.as_secs()))
    })?
}

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
    with_deadline("LIST", METADATA_TIMEOUT, list_folders_inner(session)).await
}

async fn list_folders_inner(session: &mut Session) -> Result<Vec<RemoteFolder>> {
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
    with_deadline("SELECT", METADATA_TIMEOUT, select_inner(session, folder)).await
}

async fn select_inner(session: &mut Session, folder: &str) -> Result<SelectedFolder> {
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
    /// Selective-fetch plan derived from BODYSTRUCTURE. `None` means the
    /// server omitted or could not parse BODYSTRUCTURE; callers may retry or
    /// fall back only when the user explicitly opens the message.
    pub mime_plan: Option<MimePlan>,
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
    with_deadline(
        "UID FETCH headers",
        METADATA_TIMEOUT,
        fetch_headers_inner(session, uid_set),
    )
    .await
}

async fn fetch_headers_inner(session: &mut Session, uid_set: &str) -> Result<Vec<FetchedHeader>> {
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
            let mime_plan = fetch.bodystructure().map(mime::plan_bodystructure);
            out.push(FetchedHeader {
                uid,
                flags: flags_of(&fetch),
                internal_date_ms: fetch.internal_date().map(|d| d.timestamp_millis()),
                size: fetch.size,
                header_bytes: fetch.header().map(|h| h.to_vec()).unwrap_or_default(),
                has_attachments: mime_plan
                    .as_ref()
                    .is_some_and(MimePlan::has_file_attachments),
                mime_plan,
            });
        }
    }
    Ok(out)
}

/// A BODYSTRUCTURE-derived selective-fetch plan for one remote UID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedMimePlan {
    pub uid: u32,
    pub plan: MimePlan,
}

const MIME_PLAN_QUERY: &str = "(UID BODYSTRUCTURE)";

async fn fetch_mime_plans_batch_inner(
    session: &mut Session,
    uids: &[u32],
) -> Result<Vec<FetchedMimePlan>> {
    let uid_set = normalized_uid_set(uids)?;
    if uid_set.is_empty() {
        return Ok(Vec::new());
    }
    let requested: std::collections::HashSet<u32> = uids.iter().copied().collect();
    let mut result = std::collections::BTreeMap::<u32, MimePlan>::new();
    let mut stream = session
        .uid_fetch(&uid_set, MIME_PLAN_QUERY)
        .await
        .map_err(|error| CoreError::Imap(error.to_string()))?;
    while let Some(item) = stream.next().await {
        let fetch = item.map_err(|error| CoreError::Imap(error.to_string()))?;
        let Some(uid) = fetch.uid.filter(|uid| requested.contains(uid)) else {
            continue;
        };
        if let Some(bodystructure) = fetch.bodystructure() {
            result.insert(uid, mime::plan_bodystructure(bodystructure));
        }
    }
    Ok(result
        .into_iter()
        .map(|(uid, plan)| FetchedMimePlan { uid, plan })
        .collect())
}

/// Fetch only UID + BODYSTRUCTURE for several messages in one metadata
/// command. Results are sorted by UID; vanished UIDs or responses without a
/// usable BODYSTRUCTURE are absent.
pub async fn fetch_mime_plans_batch(
    session: &mut Session,
    uids: &[u32],
) -> Result<Vec<FetchedMimePlan>> {
    with_deadline(
        "UID FETCH MIME plans batch",
        METADATA_TIMEOUT,
        fetch_mime_plans_batch_inner(session, uids),
    )
    .await
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedSection {
    pub section: String,
    /// The bytes returned for `BODY.PEEK[<section>.MIME]`.
    pub mime_header: Vec<u8>,
    /// The still-transfer-encoded bytes returned for `BODY.PEEK[<section>]`.
    pub body: Vec<u8>,
}

/// Selectively fetched MIME sections for one UID in a multi-message FETCH.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedMessageSections {
    pub uid: u32,
    pub sections: Vec<FetchedSection>,
}

fn section_numbers(section: &str) -> Result<Vec<u32>> {
    if section.is_empty() {
        return Err(CoreError::Imap("empty IMAP body section".into()));
    }
    section
        .split('.')
        .map(|part| {
            part.parse::<u32>()
                .ok()
                .filter(|value| *value > 0)
                .ok_or_else(|| CoreError::Imap(format!("invalid IMAP body section: {section}")))
        })
        .collect()
}

fn section_paths(sections: &[String]) -> Result<Vec<(String, Vec<u32>)>> {
    sections
        .iter()
        .map(|section| Ok((section.clone(), section_numbers(section)?)))
        .collect()
}

fn section_fetch_query(paths: &[(String, Vec<u32>)]) -> String {
    format!(
        "(UID {})",
        paths
            .iter()
            .flat_map(|(section, _)| {
                [
                    format!("BODY.PEEK[{section}.MIME]"),
                    format!("BODY.PEEK[{section}]"),
                ]
            })
            .collect::<Vec<_>>()
            .join(" ")
    )
}

fn normalized_uid_set(uids: &[u32]) -> Result<String> {
    if uids.iter().any(|uid| *uid == 0) {
        return Err(CoreError::Imap("IMAP UID must be greater than zero".into()));
    }
    let mut sorted = uids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    Ok(uid_set(&sorted))
}

async fn fetch_sections_batch_inner(
    session: &mut Session,
    uids: &[u32],
    sections: &[String],
) -> Result<Vec<FetchedMessageSections>> {
    use async_imap::imap_proto::{MessageSection, SectionPath};

    // Validate both interpolated command components before touching the
    // session. UIDs are numeric, sorted, and de-duplicated; sections accept
    // only positive dot-separated integers.
    let paths = section_paths(sections)?;
    let uid_set = normalized_uid_set(uids)?;
    if paths.is_empty() || uid_set.is_empty() {
        return Ok(Vec::new());
    }
    let query = section_fetch_query(&paths);
    let requested: std::collections::HashSet<u32> = uids.iter().copied().collect();

    let mut result = std::collections::BTreeMap::<u32, Vec<FetchedSection>>::new();
    let mut stream = session
        .uid_fetch(&uid_set, &query)
        .await
        .map_err(|error| CoreError::Imap(error.to_string()))?;
    while let Some(item) = stream.next().await {
        let fetch = item.map_err(|error| CoreError::Imap(error.to_string()))?;
        let Some(uid) = fetch.uid.filter(|uid| requested.contains(uid)) else {
            continue;
        };
        let fetched = result.entry(uid).or_default();
        for (section, numbers) in &paths {
            let body_path = SectionPath::Part(numbers.clone(), None);
            let mime_path = SectionPath::Part(numbers.clone(), Some(MessageSection::Mime));
            if let Some(body) = fetch.section(&body_path) {
                // A duplicate response for the same UID should not duplicate
                // a section in the public result.
                if fetched.iter().any(|item| item.section == *section) {
                    continue;
                }
                fetched.push(FetchedSection {
                    section: section.clone(),
                    mime_header: fetch
                        .section(&mime_path)
                        .map(ToOwned::to_owned)
                        .unwrap_or_default(),
                    body: body.to_vec(),
                });
            }
        }
    }
    Ok(result
        .into_iter()
        .map(|(uid, sections)| FetchedMessageSections { uid, sections })
        .collect())
}

/// Fetch the same planned readable MIME sections for several messages in one
/// UID FETCH command. Missing/expunged UIDs are absent from the result.
pub async fn fetch_content_sections_batch(
    session: &mut Session,
    uids: &[u32],
    sections: &[String],
) -> Result<Vec<FetchedMessageSections>> {
    with_deadline(
        "UID FETCH content sections batch",
        CONTENT_TIMEOUT,
        fetch_sections_batch_inner(session, uids, sections),
    )
    .await
}

/// Fetch only the planned readable MIME sections for one message. Callers
/// should pass `MimePlan::text_section_ids()`; non-text attachment sections
/// are never added implicitly.
pub async fn fetch_content_sections(
    session: &mut Session,
    uid: u32,
    sections: &[String],
) -> Result<Vec<FetchedSection>> {
    let mut messages = fetch_content_sections_batch(session, &[uid], sections).await?;
    Ok(messages
        .pop()
        .map(|message| message.sections)
        .unwrap_or_default())
}

/// Fetch one attachment/inline section on demand. The section is validated as
/// a numeric BODY path before being interpolated into the IMAP command.
pub async fn fetch_attachment_section(
    session: &mut Session,
    uid: u32,
    section: &str,
) -> Result<Option<FetchedSection>> {
    let sections = [section.to_owned()];
    let mut messages = with_deadline(
        "UID FETCH attachment section",
        ATTACHMENT_TIMEOUT,
        fetch_sections_batch_inner(session, &[uid], &sections),
    )
    .await?;
    Ok(messages
        .pop()
        .and_then(|mut message| message.sections.pop()))
}

/// Fetch flags only, for a UID window (change detection without CONDSTORE).
pub async fn fetch_flags(session: &mut Session, uid_set: &str) -> Result<Vec<(u32, FetchedFlags)>> {
    with_deadline(
        "UID FETCH flags",
        METADATA_TIMEOUT,
        fetch_flags_inner(session, uid_set),
    )
    .await
}

async fn fetch_flags_inner(
    session: &mut Session,
    uid_set: &str,
) -> Result<Vec<(u32, FetchedFlags)>> {
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
    with_deadline(
        "UID FETCH message",
        CONTENT_TIMEOUT,
        fetch_full_inner(session, uid),
    )
    .await
}

async fn fetch_full_inner(session: &mut Session, uid: u32) -> Result<Option<Vec<u8>>> {
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
pub async fn fetch_full_batch(session: &mut Session, uid_set: &str) -> Result<Vec<(u32, Vec<u8>)>> {
    with_deadline(
        "UID FETCH message batch",
        CONTENT_TIMEOUT,
        fetch_full_batch_inner(session, uid_set),
    )
    .await
}

async fn fetch_full_batch_inner(
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
    with_deadline(
        "UID SEARCH ALL",
        METADATA_TIMEOUT,
        uid_search_all_inner(session),
    )
    .await
}

async fn uid_search_all_inner(session: &mut Session) -> Result<Vec<u32>> {
    let set = session
        .uid_search("ALL")
        .await
        .map_err(|e| CoreError::Imap(e.to_string()))?;
    let mut v: Vec<u32> = set.into_iter().collect();
    v.sort_unstable();
    Ok(v)
}

pub async fn uid_search_since(session: &mut Session, date: chrono::NaiveDate) -> Result<Vec<u32>> {
    with_deadline(
        "UID SEARCH SINCE",
        METADATA_TIMEOUT,
        uid_search_since_inner(session, date),
    )
    .await
}

async fn uid_search_since_inner(
    session: &mut Session,
    date: chrono::NaiveDate,
) -> Result<Vec<u32>> {
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
    with_deadline(
        "UID STORE",
        METADATA_TIMEOUT,
        store_flag_inner(session, uid, flag, add),
    )
    .await
}

async fn store_flag_inner(session: &mut Session, uid: u32, flag: &str, add: bool) -> Result<()> {
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
    with_deadline(
        "UID MOVE",
        METADATA_TIMEOUT,
        uid_move_inner(session, uid, target),
    )
    .await
}

async fn uid_move_inner(session: &mut Session, uid: u32, target: &str) -> Result<()> {
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
    with_deadline(
        "APPEND",
        CONTENT_TIMEOUT,
        append_inner(session, folder, raw, seen),
    )
    .await
}

async fn append_inner(session: &mut Session, folder: &str, raw: &[u8], seen: bool) -> Result<()> {
    let flags = if seen { Some("(\\Seen)") } else { None };
    session
        .append(folder, flags, None, raw)
        .await
        .map_err(|e| CoreError::Imap(e.to_string()))?;
    Ok(())
}

pub async fn create_folder(session: &mut Session, name: &str) -> Result<()> {
    with_deadline(
        "CREATE",
        METADATA_TIMEOUT,
        create_folder_inner(session, name),
    )
    .await
}

async fn create_folder_inner(session: &mut Session, name: &str) -> Result<()> {
    session
        .create(name)
        .await
        .map_err(|e| CoreError::Imap(e.to_string()))
}

/// Expunge all \Deleted messages in the selected folder.
pub async fn expunge_all(session: &mut Session) -> Result<()> {
    with_deadline("EXPUNGE", METADATA_TIMEOUT, expunge_all_inner(session)).await
}

async fn expunge_all_inner(session: &mut Session) -> Result<()> {
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
    with_deadline("NOOP", METADATA_TIMEOUT, noop_inner(session)).await
}

async fn noop_inner(session: &mut Session) -> Result<()> {
    session
        .noop()
        .await
        .map_err(|e| CoreError::Imap(e.to_string()))
}

pub async fn logout(mut session: Session) {
    // Logout is best-effort cleanup; a broken server must not hold actor
    // shutdown or reconnect hostage indefinitely.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), session.logout()).await;
}

/// Whether the server advertises the IDLE extension (RFC 2177). Issues a
/// CAPABILITY command; callers cache the result for the connection's lifetime.
pub async fn supports_idle(session: &mut Session) -> Result<bool> {
    with_deadline("CAPABILITY", METADATA_TIMEOUT, supports_idle_inner(session)).await
}

async fn supports_idle_inner(session: &mut Session) -> Result<bool> {
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
    let session = match tokio::time::timeout(std::time::Duration::from_secs(10), idle.done()).await
    {
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
        while i + 1 < uids.len() && end.checked_add(1) == Some(uids[i + 1]) {
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
    use super::{normalized_uid_set, section_fetch_query, section_paths, MIME_PLAN_QUERY};

    #[test]
    fn uid_set_compresses() {
        assert_eq!(super::uid_set(&[1, 2, 3, 5, 7, 8]), "1:3,5,7:8");
        assert_eq!(super::uid_set(&[]), "");
        assert_eq!(super::uid_set(&[42]), "42");
        assert_eq!(super::uid_set(&[u32::MAX]), u32::MAX.to_string());
    }

    #[test]
    fn batch_uid_set_is_sorted_deduplicated_and_rejects_zero() {
        assert_eq!(normalized_uid_set(&[9, 2, 3, 2, 4]).unwrap(), "2:4,9");
        assert_eq!(normalized_uid_set(&[]).unwrap(), "");
        assert!(normalized_uid_set(&[1, 0, 2]).is_err());
    }

    #[test]
    fn selective_section_query_accepts_only_numeric_paths() {
        let sections = vec!["1".to_string(), "2.3".to_string()];
        let paths = section_paths(&sections).unwrap();
        assert_eq!(
            section_fetch_query(&paths),
            "(UID BODY.PEEK[1.MIME] BODY.PEEK[1] BODY.PEEK[2.3.MIME] BODY.PEEK[2.3])"
        );

        for invalid in ["", "0", "1.0", "1..2", "1] BODY.PEEK[]", "-1", "1.a"] {
            assert!(
                section_paths(&[invalid.to_string()]).is_err(),
                "accepted invalid section {invalid:?}"
            );
        }
    }

    #[test]
    fn mime_plan_batch_query_is_bodystructure_only() {
        assert_eq!(MIME_PLAN_QUERY, "(UID BODYSTRUCTURE)");
        for excluded in ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "HEADER.FIELDS"] {
            assert!(!MIME_PLAN_QUERY.contains(excluded));
        }
    }
}
