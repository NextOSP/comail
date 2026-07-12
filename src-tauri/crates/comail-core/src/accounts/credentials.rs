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
}

impl Slot {
    fn as_str(&self) -> &'static str {
        match self {
            Slot::Password => "password",
            Slot::RefreshToken => "refresh_token",
            Slot::AccessToken => "access_token",
            Slot::AiApiKey => "ai_api_key",
        }
    }
}

fn entry(account_id: i64, slot: &Slot) -> Result<keyring::Entry> {
    let user = format!("{account_id}:{}", slot.as_str());
    keyring::Entry::new(SERVICE, &user).map_err(Into::into)
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
    entry(account_id, &slot)?
        .set_password(secret)
        .map_err(Into::into)
}

pub fn load(account_id: i64, slot: Slot) -> Result<String> {
    if let Some(path) = insecure_file() {
        return file_map(&path)
            .remove(&slot_key(account_id, &slot))
            .ok_or_else(|| CoreError::Auth("no stored credential".into()));
    }
    match entry(account_id, &slot)?.get_password() {
        Ok(s) => Ok(s),
        Err(keyring::Error::NoEntry) => Err(CoreError::Auth("no stored credential".into())),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_all(account_id: i64) {
    if let Some(path) = insecure_file() {
        let mut map = file_map(&path);
        map.retain(|k, _| !k.starts_with(&format!("{account_id}:")));
        let _ = file_save(&path, &map);
        return;
    }
    for slot in [Slot::Password, Slot::RefreshToken, Slot::AccessToken] {
        if let Ok(e) = entry(account_id, &slot) {
            let _ = e.delete_credential();
        }
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
