//! Authorization-code + PKCE flow over the localhost loopback redirect.
//! The browser is opened by the caller (Tauri layer) via the `open_url`
//! callback so this crate stays UI-free.

use crate::error::{CoreError, Result};
use crate::models::Provider;
use crate::oauth::loopback::LoopbackServer;
use crate::oauth::providers::for_provider;
use crate::oauth::tokens::post_form;
use base64::Engine;
use sha2::Digest;

pub struct OAuthOutcome {
    pub email: String,
    pub access_token: String,
    pub expires_in: Option<i64>,
    pub refresh_token: Option<String>,
}

fn random_string(len: usize) -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    (0..len)
        .map(|_| CHARS[rng.random_range(0..CHARS.len())] as char)
        .collect()
}

#[derive(serde::Deserialize)]
struct ExchangeResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
}

fn email_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    json["email"].as_str().map(|s| s.to_string())
}

pub async fn authorize(
    provider: Provider,
    open_url: impl FnOnce(String) + Send,
) -> Result<OAuthOutcome> {
    authorize_with(provider, &[], None, open_url).await
}

/// Like `authorize` but with additional scopes (incremental consent, e.g.
/// Google Calendar) and a login hint so re-consent lands on the right account.
pub async fn authorize_with(
    provider: Provider,
    extra_scopes: &[&str],
    login_hint: Option<&str>,
    open_url: impl FnOnce(String) + Send,
) -> Result<OAuthOutcome> {
    let cfg = for_provider(provider)
        .ok_or_else(|| CoreError::Auth("provider does not use oauth".into()))?;
    let (client_id, client_secret) = crate::oauth::providers::resolve_credentials(provider)?;

    let verifier = random_string(64);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(sha2::Sha256::digest(verifier.as_bytes()));
    let state = random_string(32);

    let server = LoopbackServer::bind().await?;
    let redirect_uri = server.redirect_uri();

    let mut scopes = cfg.scopes.join(" ");
    for extra in extra_scopes {
        if !scopes.contains(extra) {
            scopes.push(' ');
            scopes.push_str(extra);
        }
    }
    let mut auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        cfg.auth_url,
        urlencode(&client_id),
        urlencode(&redirect_uri),
        urlencode(&scopes),
        urlencode(&state),
        urlencode(&challenge),
    );
    if provider == Provider::Gmail {
        auth_url.push_str("&access_type=offline&prompt=consent");
    }
    if let Some(hint) = login_hint {
        auth_url.push_str(&format!("&login_hint={}", urlencode(hint)));
    }

    open_url(auth_url);

    let code = server
        .wait_for_code(std::time::Duration::from_secs(300))
        .await?;
    if code.state.as_deref() != Some(state.as_str()) {
        return Err(CoreError::Auth("oauth state mismatch".into()));
    }

    let mut form = vec![
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("code".to_string(), code.code),
        ("redirect_uri".to_string(), redirect_uri),
        ("client_id".to_string(), client_id),
        ("code_verifier".to_string(), verifier),
    ];
    if let Some(cs) = client_secret {
        form.push(("client_secret".to_string(), cs));
    }

    let body = post_form(cfg.token_url, &form).await?;
    let tok: ExchangeResponse = serde_json::from_str(&body)
        .map_err(|_| CoreError::Auth(format!("token exchange failed: {body}")))?;

    let email = tok
        .id_token
        .as_deref()
        .and_then(email_from_id_token)
        .ok_or_else(|| CoreError::Auth("could not determine account email".into()))?;

    Ok(OAuthOutcome {
        email,
        access_token: tok.access_token,
        expires_in: tok.expires_in,
        refresh_token: tok.refresh_token,
    })
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
