//! Capability-driven remote identities and provider-specific mailbox hints.
use crate::db::repo::messages::MessageRow;
use crate::error::{CoreError, Result};
use crate::imap::{self, Session};
use crate::models::Provider;
use serde::{Deserialize, Serialize};
use std::{future::Future, pin::Pin};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServerCaps {
    pub uidplus: bool,
    pub move_: bool,
    pub gmail_ext: bool,
    pub objectid: bool,
    pub idle: bool,
}

impl ServerCaps {
    pub async fn from_session<T>(session: &mut async_imap::Session<T>) -> Result<Self>
    where
        T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
    {
        tokio::time::timeout(imap::METADATA_TIMEOUT, async {
            let caps = session
                .capabilities()
                .await
                .map_err(|e| CoreError::Imap(e.to_string()))?;
            Ok(Self {
                uidplus: caps.has_str("UIDPLUS"),
                move_: caps.has_str("MOVE"),
                gmail_ext: caps.has_str("X-GM-EXT-1"),
                objectid: caps.has_str("OBJECTID"),
                idle: caps.has_str("IDLE"),
            })
        })
        .await
        .map_err(|_| CoreError::Imap("CAPABILITY timed out".into()))?
    }
}

/// INTERNALDATE is UNIX seconds, not the header Date or milliseconds.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum RemoteKey {
    GmailMsgId(u64),
    EmailId(String),
    Header {
        message_id: String,
        internal_date: Option<i64>,
        size: Option<i64>,
    },
}

/// Select the strongest persisted identity even when capabilities are not yet known.
pub fn remote_key(row: &MessageRow) -> Option<RemoteKey> {
    key_from_parts(
        row.gm_msgid.as_deref(),
        row.message_id.as_deref(),
        row.internal_date.map(|ms| ms.div_euclid(1000)),
        row.size,
    )
}

pub fn key_from_parts(
    gmail: Option<&str>,
    message_id: Option<&str>,
    internal_date: Option<i64>,
    size: Option<i64>,
) -> Option<RemoteKey> {
    if let Some(id) = gmail
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|id| *id > 0)
    {
        return Some(RemoteKey::GmailMsgId(id));
    }
    // TODO: retain OBJECTID metadata but use Header until upstream imap-proto
    // supports EMAILID FETCH and exact verification through its buffered codec.
    let message_id = message_id?
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>');
    if message_id.is_empty()
        || message_id.len() > 998
        || !message_id.is_ascii()
        || message_id.bytes().any(|b| b.is_ascii_control())
    {
        return None;
    }
    Some(RemoteKey::Header {
        message_id: message_id.into(),
        internal_date,
        size,
    })
}

impl RemoteKey {
    /// Fallible variant used for protocol commands; malformed queued keys never reach the wire.
    pub fn checked_search_criteria(&self) -> Result<String> {
        match self {
            Self::GmailMsgId(id) if *id > 0 => Ok(format!("X-GM-MSGID {id}")),
            Self::EmailId(_) => Err(CoreError::ActionRejected(
                "EMAILID is not supported yet".into(),
            )),
            Self::Header { message_id, .. } => {
                imap::message_id_search_query(message_id).map(|(_, query)| query)
            }
            _ => Err(CoreError::ActionRejected("Invalid remote identity".into())),
        }
    }
}

pub type ExpungeFuture<'a> = Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;

pub trait MailboxBehavior: Send + Sync {
    fn identity_fetch_items(&self) -> &'static [&'static str];
    fn remote_key(&self, row: &MessageRow) -> Option<RemoteKey> {
        remote_key(row)
    }
    /// Invalid identities deliberately match nothing; executors use the fallible variant.
    fn search_criteria(&self, key: &RemoteKey) -> String {
        key.checked_search_criteria()
            .unwrap_or_else(|_| "UID 0".into())
    }
    fn checked_search_criteria(&self, key: &RemoteKey) -> Result<String> {
        key.checked_search_criteria()?;
        Ok(self.search_criteria(key))
    }
    fn requires_special_use_for_delete(&self) -> bool {
        false
    }
    fn role_name_rank(&self, name: &str) -> Option<u8> {
        let _ = name;
        Some(1)
    }
    fn trash_name_hints(&self) -> &'static [&'static str];
    /// Caller must first select and validate the server's Trash and verify each UID's identity.
    fn expunge_uids<'a>(&'a self, session: &'a mut Session, uids: &'a [u32]) -> ExpungeFuture<'a> {
        Box::pin(async move {
            if uids.is_empty() {
                return Ok(());
            }
            let prepared = imap::prepare_uid_delete(session, uids).await?;
            prepared.execute(session).await?;
            Ok(())
        })
    }
}

struct Behavior {
    provider: Provider,
    gmail: bool,
}

impl MailboxBehavior for Behavior {
    fn identity_fetch_items(&self) -> &'static [&'static str] {
        if self.gmail { &["X-GM-MSGID"] } else { &[] }
    }

    fn requires_special_use_for_delete(&self) -> bool {
        self.gmail || self.provider == Provider::Gmail
    }
    fn role_name_rank(&self, name: &str) -> Option<u8> {
        if !self.requires_special_use_for_delete() {
            return Some(1);
        }
        let name = name.to_ascii_lowercase();
        (name.starts_with("[gmail]/") || name.starts_with("[google mail]/")).then_some(2)
    }

    fn trash_name_hints(&self) -> &'static [&'static str] {
        if self.gmail || self.provider == Provider::Gmail {
            &[
                "[Gmail]/Trash",
                "[Google Mail]/Trash",
                "[Gmail]/Bin",
                "[Google Mail]/Bin",
                "[Gmail]/Corbeille",
                "[Gmail]/Papierkorb",
                "[Gmail]/Papelera",
                "[Gmail]/Cestino",
                "[Gmail]/Lixeira",
                "Trash",
            ]
        } else if self.provider == Provider::Microsoft {
            &["Deleted Items", "Deleted Messages", "Trash"]
        } else {
            &["Trash", "Deleted Messages", "Deleted Items"]
        }
    }
}

pub fn behavior_for(provider: Provider, caps: &ServerCaps) -> Box<dyn MailboxBehavior> {
    Box::new(Behavior {
        provider,
        gmail: caps.gmail_ext,
    })
}

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedIdentity {
    pub uid: u32,
    pub gm_msgid: Option<String>,
    pub message_id: Option<String>,
    /// False when the requested header section was omitted, not merely empty.
    pub header_fetched: bool,
    pub internal_date: Option<i64>,
    pub size: Option<i64>,
}

impl FetchedIdentity {
    pub fn remote_key(&self) -> Option<RemoteKey> {
        key_from_parts(
            self.gm_msgid.as_deref(),
            self.message_id.as_deref(),
            self.internal_date,
            self.size,
        )
    }

    pub fn matches(&self, key: &RemoteKey) -> bool {
        match key {
            RemoteKey::GmailMsgId(id) => {
                self.gm_msgid.as_deref().and_then(|s| s.parse::<u64>().ok()) == Some(*id)
            }
            RemoteKey::EmailId(_) => false,
            RemoteKey::Header {
                message_id,
                internal_date,
                size,
            } => {
                let Ok((expected, _)) = imap::message_id_search_query(message_id) else {
                    return false;
                };
                self.header_fetched
                    && self.message_id.as_deref() == Some(expected.as_str())
                    && internal_date.is_none_or(|date| self.internal_date == Some(date))
                    && size.is_none_or(|size| self.size == Some(size))
            }
        }
    }
}

/// Extract only provider identities; no message headers are parsed here.
pub fn gmail_id(fetch: &async_imap::types::Fetch) -> Option<u64> {
    fetch.gmail_msg_id().copied()
}

impl RemoteKey {
    pub fn is_header(&self) -> bool {
        matches!(self, Self::Header { .. })
    }
    pub fn is_stable(&self) -> bool {
        !self.is_header()
    }
    pub fn allows_multiple_matches(&self) -> bool {
        self.is_stable()
    }
    pub fn bucket(&self) -> String {
        match self {
            Self::GmailMsgId(id) => format!("g:{id}"),
            Self::EmailId(id) => format!("e:{id}"),
            Self::Header { message_id, .. } => format!("h:{message_id}"),
        }
    }
    pub fn matches_row(&self, row: &MessageRow) -> bool {
        FetchedIdentity {
            uid: 0,
            gm_msgid: row.gm_msgid.clone(),
            message_id: row
                .message_id
                .as_deref()
                .and_then(|id| imap::message_id_search_query(id).ok().map(|(id, _)| id)),
            header_fetched: true,
            internal_date: row.internal_date.map(|ms| ms.div_euclid(1000)),
            size: row.size,
        }
        .matches(self)
    }
    /// A complete listing can prove absence only when every required field is present.
    pub fn identity_complete(&self, identities: &[FetchedIdentity]) -> bool {
        identities.iter().all(|item| match self {
            Self::GmailMsgId(_) => item.gm_msgid.is_some(),
            Self::EmailId(_) => false,
            Self::Header {
                internal_date,
                size,
                ..
            } => {
                item.header_fetched
                    && (!item.buckets().contains(&self.bucket())
                        || ((internal_date.is_none() || item.internal_date.is_some())
                            && (size.is_none() || item.size.is_some())))
            }
        }) && !matches!(self, Self::EmailId(_))
    }
    pub fn ensure_supported(&self) -> Result<()> {
        self.checked_search_criteria().map(|_| ())
    }
}

/// Offline fallback used before a session exists, including legacy host-only accounts.
pub fn behavior_for_account(provider: &str, host: &str) -> Box<dyn MailboxBehavior> {
    let provider = if host.eq_ignore_ascii_case("imap.gmail.com")
        || host.eq_ignore_ascii_case("imap.googlemail.com")
    {
        Provider::Gmail
    } else {
        Provider::from_str(provider)
    };
    behavior_for(provider, &ServerCaps::default())
}

impl FetchedIdentity {
    pub fn buckets(&self) -> Vec<String> {
        let mut keys = Vec::new();
        if let Some(key) = self.remote_key() {
            keys.push(key.bucket());
        }
        if let Some(key) = key_from_parts(
            None,
            self.message_id.as_deref(),
            self.internal_date,
            self.size,
        ) {
            let bucket = key.bucket();
            if !keys.contains(&bucket) {
                keys.push(bucket);
            }
        }
        keys
    }
}

/// Callers must verify the row/action link before persisting newly observed identity.
pub fn persist_identity(
    conn: &rusqlite::Connection,
    id: i64,
    identity: &FetchedIdentity,
) -> Result<()> {
    conn.execute(
        "UPDATE messages SET gm_msgid = COALESCE(gm_msgid, ?2) WHERE id = ?1",
        rusqlite::params![id, identity.gm_msgid],
    )?;
    Ok(())
}
