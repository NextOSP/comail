use crate::error::{CoreError, Result};
use crate::models::Provider;

/// Incremental-consent scope for Google Calendar (CalDAV access). Not in
/// the default GOOGLE scopes: mail-only accounts should not be asked for it.
pub const GOOGLE_CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar";
use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

pub struct OAuthProviderConfig {
    pub auth_url: &'static str,
    pub token_url: &'static str,
    pub scopes: &'static [&'static str],
    /// Env var names let users supply their own app registrations.
    pub client_id_env: &'static str,
    pub client_secret_env: &'static str,
}

pub const GOOGLE: OAuthProviderConfig = OAuthProviderConfig {
    auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    // mail.google.com is the only scope Google accepts for IMAP/SMTP XOAUTH2.
    scopes: &["https://mail.google.com/", "openid", "email"],
    client_id_env: "COMAIL_GOOGLE_CLIENT_ID",
    client_secret_env: "COMAIL_GOOGLE_CLIENT_SECRET",
};

pub const MICROSOFT: OAuthProviderConfig = OAuthProviderConfig {
    auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: &[
        "https://outlook.office.com/IMAP.AccessAsUser.All",
        "https://outlook.office.com/SMTP.Send",
        "offline_access",
        "openid",
        "email",
    ],
    client_id_env: "COMAIL_MS_CLIENT_ID",
    client_secret_env: "COMAIL_MS_CLIENT_SECRET",
};

pub fn for_provider(p: Provider) -> Option<&'static OAuthProviderConfig> {
    match p {
        Provider::Gmail => Some(&GOOGLE),
        Provider::Microsoft => Some(&MICROSOFT),
        Provider::Imap => None,
    }
}

/// Client credentials the user entered in Settings. Refreshed on startup and
/// whenever settings change; env vars still take precedence at resolve time.
fn configured() -> &'static RwLock<HashMap<Provider, (String, Option<String>)>> {
    static MAP: OnceLock<RwLock<HashMap<Provider, (String, Option<String>)>>> = OnceLock::new();
    MAP.get_or_init(Default::default)
}

pub fn set_configured(provider: Provider, client_id: &str, client_secret: &str) {
    let mut map = configured().write().unwrap();
    let id = client_id.trim();
    if id.is_empty() {
        map.remove(&provider);
    } else {
        let secret = Some(client_secret.trim())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        map.insert(provider, (id.to_string(), secret));
    }
}

/// (client_id, client_secret) for an OAuth provider: env vars first,
/// then the values configured in Settings.
pub fn resolve_credentials(provider: Provider) -> Result<(String, Option<String>)> {
    let cfg = for_provider(provider)
        .ok_or_else(|| CoreError::Auth("provider does not use oauth".into()))?;
    if let Ok(id) = std::env::var(cfg.client_id_env) {
        return Ok((id, std::env::var(cfg.client_secret_env).ok()));
    }
    if let Some(entry) = configured().read().unwrap().get(&provider) {
        return Ok(entry.clone());
    }
    Err(CoreError::Auth(format!(
        "no OAuth app configured for {}: add a client ID in Settings → Accounts, or set {}",
        provider.as_str(),
        cfg.client_id_env
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_uses_configured_values_and_clears() {
        // Microsoft: no env vars set in the test environment.
        set_configured(Provider::Microsoft, "  ms-id  ", "");
        let (id, secret) = resolve_credentials(Provider::Microsoft).unwrap();
        assert_eq!(id, "ms-id");
        assert_eq!(secret, None);

        set_configured(Provider::Microsoft, "ms-id", "  s3cret ");
        let (_, secret) = resolve_credentials(Provider::Microsoft).unwrap();
        assert_eq!(secret.as_deref(), Some("s3cret"));

        // Empty id clears the registration entirely.
        set_configured(Provider::Microsoft, "", "whatever");
        assert!(resolve_credentials(Provider::Microsoft).is_err());
    }

    #[test]
    fn resolve_rejects_non_oauth_provider() {
        assert!(resolve_credentials(Provider::Imap).is_err());
    }
}
