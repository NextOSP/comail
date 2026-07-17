//! Secrets live in the OS keyring (Secret Service on Linux), never in SQLite.
//! Keyring entries are keyed "comail:<account_id>:<slot>".

use crate::error::{CoreError, Result};

const SERVICE: &str = "comail";

pub enum Slot {
    Password,
    RefreshToken,
    AccessToken,
    /// App-level AI API key (stored under account id 0).
    AiApiKey,
    /// Generic-CalDAV app password (Google CalDAV reuses the OAuth tokens).
    CaldavPassword,
}

impl Slot {
    fn as_str(&self) -> &'static str {
        match self {
            Slot::Password => "password",
            Slot::RefreshToken => "refresh_token",
            Slot::AccessToken => "access_token",
            Slot::AiApiKey => "ai_api_key",
            Slot::CaldavPassword => "caldav_password",
        }
    }
}

fn entry(account_id: i64, slot: &Slot) -> Result<keyring::Entry> {
    let user = format!("{account_id}:{}", slot.as_str());
    keyring::Entry::new(SERVICE, &user).map_err(Into::into)
}

// Windows Credential Manager caps a credential blob at 2560 bytes
// (CRED_MAX_CREDENTIAL_BLOB_SIZE) and the native store encodes secrets as
// UTF-16, so ~1280 code units. Microsoft AAD refresh tokens routinely exceed
// that, and the store then fails with a "secure storage error" that leaves the
// account uncredentialed. Split oversized secrets across sibling entries on
// Windows; other platforms have no such limit and store secrets whole.
#[cfg(target_os = "windows")]
const MAX_SECRET_UTF16: usize = 1024;
#[cfg(not(target_os = "windows"))]
const MAX_SECRET_UTF16: usize = usize::MAX;

// A NUL-prefixed header no real token or password starts with. When present in
// the primary entry it means the value is split across `<slot>:c0..cN` entries.
const CHUNK_MARKER: &str = "\u{0}comail-chunks:";

// Chunk sanity cap; MAX_SECRET_UTF16 * this is far beyond any real secret.
const MAX_CHUNKS: usize = 256;

fn chunk_entry(account_id: i64, slot: &Slot, index: usize) -> Result<keyring::Entry> {
    let user = format!("{account_id}:{}:c{index}", slot.as_str());
    keyring::Entry::new(SERVICE, &user).map_err(Into::into)
}

/// Split on char boundaries so no chunk exceeds `max_units` UTF-16 code units
/// (what the Windows blob limit counts). Returns a single chunk when it fits.
fn split_utf16_chunks(secret: &str, max_units: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut cur = String::new();
    let mut units = 0usize;
    for ch in secret.chars() {
        let w = ch.len_utf16();
        if units.saturating_add(w) > max_units && !cur.is_empty() {
            chunks.push(std::mem::take(&mut cur));
            units = 0;
        }
        cur.push(ch);
        units += w;
    }
    chunks.push(cur);
    chunks
}

/// Delete `<slot>:c{index}` entries starting at `start`. Chunks are written
/// contiguously, so stop at the first missing (or unreadable) index.
fn delete_chunks_from(account_id: i64, slot: &Slot, start: usize) {
    for index in start..start + MAX_CHUNKS {
        match chunk_entry(account_id, slot, index) {
            Ok(e) => match e.delete_credential() {
                Ok(()) => {}
                _ => break,
            },
            Err(_) => break,
        }
    }
}

/// Fallback for machines without a Secret Service (headless boxes, tests):
/// COMAIL_CREDENTIALS_INSECURE_FILE=<path> stores secrets as plaintext JSON.
/// The OS keyring is always preferred; never set this on a desktop.
fn insecure_file() -> Option<std::path::PathBuf> {
    std::env::var("COMAIL_CREDENTIALS_INSECURE_FILE")
        .ok()
        .filter(|p| !p.is_empty())
        .map(std::path::PathBuf::from)
}

fn file_map(path: &std::path::Path) -> std::collections::HashMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn file_save(
    path: &std::path::Path,
    map: &std::collections::HashMap<String, String>,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string(map)?)?;
    Ok(())
}

fn slot_key(account_id: i64, slot: &Slot) -> String {
    format!("{account_id}:{}", slot.as_str())
}

/// Keyring calls are blocking (D-Bus on Linux); call from spawn_blocking in async paths.
pub fn store(account_id: i64, slot: Slot, secret: &str) -> Result<()> {
    if let Some(path) = insecure_file() {
        let mut map = file_map(&path);
        map.insert(slot_key(account_id, &slot), secret.to_string());
        return file_save(&path, &map);
    }
    let chunks = split_utf16_chunks(secret, MAX_SECRET_UTF16);
    if chunks.len() <= 1 {
        // Fits in one entry (always the case off Windows). On Windows, clear any
        // stale chunks left by a previous oversized value, then store whole.
        #[cfg(target_os = "windows")]
        delete_chunks_from(account_id, &slot, 0);
        return entry(account_id, &slot)?
            .set_password(secret)
            .map_err(Into::into);
    }
    // Write data chunks first, header last: a partial write never reassembles.
    for (index, part) in chunks.iter().enumerate() {
        chunk_entry(account_id, &slot, index)?
            .set_password(part)
            .map_err(CoreError::from)?;
    }
    delete_chunks_from(account_id, &slot, chunks.len());
    entry(account_id, &slot)?
        .set_password(&format!("{CHUNK_MARKER}{}", chunks.len()))
        .map_err(Into::into)
}

pub fn load(account_id: i64, slot: Slot) -> Result<String> {
    if let Some(path) = insecure_file() {
        return file_map(&path)
            .remove(&slot_key(account_id, &slot))
            .ok_or_else(|| CoreError::Auth("no stored credential".into()));
    }
    let head = match entry(account_id, &slot)?.get_password() {
        Ok(s) => s,
        Err(keyring::Error::NoEntry) => return Err(CoreError::Auth("no stored credential".into())),
        Err(e) => return Err(e.into()),
    };
    let Some(count) = head.strip_prefix(CHUNK_MARKER) else {
        return Ok(head);
    };
    let count: usize = count
        .parse()
        .map_err(|_| CoreError::Other("corrupt keyring chunk header".into()))?;
    let mut out = String::new();
    for index in 0..count {
        match chunk_entry(account_id, &slot, index)?.get_password() {
            Ok(s) => out.push_str(&s),
            Err(keyring::Error::NoEntry) => {
                return Err(CoreError::Auth("no stored credential".into()));
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(out)
}

pub fn delete_all(account_id: i64) {
    if let Some(path) = insecure_file() {
        let mut map = file_map(&path);
        map.retain(|k, _| !k.starts_with(&format!("{account_id}:")));
        let _ = file_save(&path, &map);
        return;
    }
    for slot in [
        Slot::Password,
        Slot::RefreshToken,
        Slot::AccessToken,
        Slot::CaldavPassword,
    ] {
        if let Ok(e) = entry(account_id, &slot) {
            let _ = e.delete_credential();
        }
        delete_chunks_from(account_id, &slot, 0);
    }
}

pub async fn store_async(account_id: i64, slot: Slot, secret: String) -> Result<()> {
    tokio::task::spawn_blocking(move || store(account_id, slot, &secret))
        .await
        .map_err(|e| CoreError::Other(e.to_string()))?
}

pub async fn load_async(account_id: i64, slot: Slot) -> Result<String> {
    tokio::task::spawn_blocking(move || load(account_id, slot))
        .await
        .map_err(|e| CoreError::Other(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_secret_is_one_chunk() {
        assert_eq!(split_utf16_chunks("abc", 1024), vec!["abc"]);
        assert_eq!(split_utf16_chunks("", 1024), vec![""]);
    }

    #[test]
    fn oversized_secret_splits_and_rejoins() {
        let secret: String = "a".repeat(2500);
        let chunks = split_utf16_chunks(&secret, 1024);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.encode_utf16().count() <= 1024));
        assert_eq!(chunks.concat(), secret);
    }

    #[test]
    fn split_never_breaks_a_surrogate_pair() {
        // '😀' is two UTF-16 code units; a boundary must not land mid-char.
        let secret: String = "😀".repeat(600); // 1200 UTF-16 units
        let chunks = split_utf16_chunks(&secret, 1023); // odd cap, forces a squeeze
        assert!(chunks.iter().all(|c| c.encode_utf16().count() <= 1023));
        assert_eq!(chunks.concat(), secret);
    }
}
