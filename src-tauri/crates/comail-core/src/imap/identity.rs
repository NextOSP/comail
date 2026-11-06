//! Exact identity verification and response-code-preserving moves.
use super::*;
pub use crate::provider::FetchedIdentity;
use crate::provider::{MailboxBehavior, RemoteKey, gmail_id};
use async_imap::imap_proto::{Response, ResponseCode, Status, UidSetMember};

pub async fn fetch_identities<
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
>(
    session: &mut async_imap::Session<T>,
    uid_set: &str,
    behavior: &dyn MailboxBehavior,
) -> Result<Vec<FetchedIdentity>> {
    validate_uid_set(uid_set)?;
    with_deadline("UID FETCH identities", METADATA_TIMEOUT, async {
        let items = behavior.identity_fetch_items();
        let extra = items.join(" ");
        let query =
            format!("(UID INTERNALDATE RFC822.SIZE {extra} BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])");
        let mut out = Vec::new();
        {
            let mut stream = session
                .uid_fetch(uid_set, query)
                .await
                .map_err(map_search_error)?;
            while let Some(item) = stream.next().await {
                let fetch = item.map_err(map_search_error)?;
                let Some(uid) = fetch.uid else {
                    continue;
                };
                let parsed = fetch.header().map(mime::parse_header_block).transpose()?;
                out.push(FetchedIdentity {
                    uid,
                    gm_msgid: gmail_id(&fetch).map(|id| id.to_string()),
                    message_id: parsed.and_then(|h| h.message_id),
                    header_fetched: fetch.header().is_some(),
                    internal_date: fetch.internal_date().map(|d| d.timestamp()),
                    size: fetch.size.map(i64::from),
                });
            }
        }
        Ok(out)
    })
    .await
}

pub async fn search_remote_identities<
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
>(
    session: &mut async_imap::Session<T>,
    key: &RemoteKey,
    behavior: &dyn MailboxBehavior,
) -> Result<Vec<FetchedIdentity>> {
    key.ensure_supported()?;
    with_deadline("UID SEARCH remote key", METADATA_TIMEOUT, async {
        let query = behavior.checked_search_criteria(key)?;
        let candidates = session.uid_search(query).await.map_err(map_search_error)?;
        let mut candidates: Vec<_> = candidates.into_iter().collect();
        candidates.sort_unstable();
        let mut verified = Vec::new();
        for chunk in candidates.chunks(200) {
            let set = normalized_uid_set(chunk)?;
            for item in fetch_identities(session, &set, behavior).await? {
                if chunk.contains(&item.uid) && item.matches(key) {
                    verified.push(item);
                }
            }
        }
        verified.sort_unstable_by_key(|item| item.uid);
        verified.dedup_by_key(|item| item.uid);
        Ok(verified)
    })
    .await
}

pub async fn verify_remote_key<
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
>(
    session: &mut async_imap::Session<T>,
    uid: u32,
    key: &RemoteKey,
    behavior: &dyn MailboxBehavior,
) -> Result<bool> {
    key.ensure_supported()?;
    if uid == 0 {
        return Err(CoreError::ActionRejected("UID must be nonzero".into()));
    }
    Ok(fetch_identities(session, &uid.to_string(), behavior)
        .await?
        .iter()
        .any(|item| item.uid == uid && item.matches(key)))
}

fn validate_uid_set(set: &str) -> Result<()> {
    if set.is_empty()
        || !set.split(',').all(|range| {
            let parts: Vec<_> = range.split(':').collect();
            parts.len() <= 2
                && parts
                    .iter()
                    .all(|p| *p == "*" || p.parse::<u32>().is_ok_and(|v| v > 0))
        })
    {
        return Err(CoreError::ActionRejected("Invalid UID set".into()));
    }
    Ok(())
}

fn quoted_mailbox(target: &str) -> Result<String> {
    if target.bytes().any(|b| b.is_ascii_control()) {
        return Err(CoreError::ActionRejected("Invalid target mailbox".into()));
    }
    Ok(format!(
        "\"{}\"",
        target.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

/// A single-message move accepts only a singleton COPYUID mapping, not a guessed
/// destination from a malformed or unrelated response.
fn copyuid_destination(code: &ResponseCode<'_>, source: u32) -> Option<u32> {
    let ResponseCode::CopyUid(validity, src, dst) = code else {
        return None;
    };
    if *validity == 0 {
        return None;
    }
    fn singleton(set: &[UidSetMember]) -> Option<u32> {
        match set {
            [UidSetMember::Uid(uid)] if *uid > 0 => Some(*uid),
            [UidSetMember::UidRange(range)]
                if range.start() == range.end() && *range.start() > 0 =>
            {
                Some(*range.start())
            }
            _ => None,
        }
    }
    (singleton(src) == Some(source))
        .then(|| singleton(dst))
        .flatten()
}

pub(super) async fn copy_or_move<
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
>(
    session: &mut async_imap::Session<T>,
    operation: &str,
    set: &str,
    target: &str,
) -> Result<Option<u32>> {
    let source = set
        .parse::<u32>()
        .map_err(|_| CoreError::ActionRejected("Expected one source UID".into()))?;
    let target = quoted_mailbox(target)?;
    let tag = session
        .run_command(format!("UID {operation} {set} {target}"))
        .await
        .map_err(map_search_error)?;
    let mut destination = None;
    while let Some(response) = session
        .read_response()
        .await
        .map_err(|e| CoreError::Imap(e.to_string()))?
    {
        match response.parsed() {
            Response::Data {
                status: Status::Ok,
                code: Some(code),
                ..
            } => {
                if let Some(uid) = copyuid_destination(code, source) {
                    destination = Some(uid);
                }
            }
            Response::Done {
                tag: response_tag,
                status,
                code,
                information,
            } if *response_tag == tag => {
                if *status != Status::Ok {
                    return Err(CoreError::Imap(format!(
                        "UID {operation} failed: {status:?} {information:?}"
                    )));
                }
                if let Some(code) = code {
                    destination = copyuid_destination(code, source).or(destination);
                }
                return Ok(destination);
            }
            Response::Data {
                status: Status::Bye,
                ..
            } => return Err(CoreError::Imap("Server closed during move".into())),
            _ => {}
        }
    }
    Err(CoreError::Imap(
        "Connection lost before move confirmation".into(),
    ))
}

#[cfg(test)]
mod tests;

pub async fn uid_search_remote_key<T>(
    session: &mut async_imap::Session<T>,
    key: &RemoteKey,
    behavior: &dyn MailboxBehavior,
) -> Result<Vec<u32>>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
{
    Ok(search_remote_identities(session, key, behavior)
        .await?
        .into_iter()
        .map(|item| item.uid)
        .collect())
}

pub async fn fetch_stable_identities<T>(
    session: &mut async_imap::Session<T>,
    uid_set: &str,
    behavior: &dyn MailboxBehavior,
) -> Result<Vec<FetchedIdentity>>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
{
    validate_uid_set(uid_set)?;
    if behavior.identity_fetch_items().is_empty() {
        return Ok(Vec::new());
    }
    with_deadline("UID FETCH stable identities", METADATA_TIMEOUT, async {
        let query = format!("(UID {})", behavior.identity_fetch_items().join(" "));
        let mut stream = session
            .uid_fetch(uid_set, query)
            .await
            .map_err(map_search_error)?;
        let mut out = Vec::new();
        while let Some(item) = stream.next().await {
            let fetch = item.map_err(map_search_error)?;
            if let Some(uid) = fetch.uid {
                out.push(FetchedIdentity {
                    uid,
                    gm_msgid: gmail_id(&fetch).map(|id| id.to_string()),
                    message_id: None,
                    header_fetched: false,
                    internal_date: None,
                    size: None,
                });
            }
        }
        Ok(out)
    })
    .await
}
