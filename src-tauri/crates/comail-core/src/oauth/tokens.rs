//! Access-token lifecycle: hands out valid tokens, refreshing behind a mutex
//! when close to expiry. Refresh tokens live in the keyring; access tokens are
//! cached in memory (and mirrored to keyring so restarts avoid one refresh).

use crate::accounts::credentials::{self, Slot};
use crate::error::{CoreError, Result};
use crate::models::Provider;
use crate::oauth::providers::for_provider;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
struct CachedToken {
    access_token: String,
    expires_at_ms: i64,
}

#[derive(Clone, Default)]
pub struct TokenProvider {
    cache: Arc<Mutex<HashMap<i64, CachedToken>>>,
}

#[derive(serde::Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    refresh_token: Option<String>,
}

impl TokenProvider {
    pub fn new() -> Self {
        Self::default()
    }

    /// Store initial tokens after the auth-code exchange.
    pub async fn store_initial(
        &self,
        account_id: i64,
        access_token: String,
        expires_in: Option<i64>,
        refresh_token: Option<String>,
    ) -> Result<()> {
        if let Some(rt) = refresh_token {
            credentials::store_async(account_id, Slot::RefreshToken, rt).await?;
        }
        let expires_at_ms =
            crate::models::now_ms() + expires_in.unwrap_or(3600).saturating_sub(60) * 1000;
        credentials::store_async(account_id, Slot::AccessToken, access_token.clone()).await?;
        self.cache.lock().await.insert(
            account_id,
            CachedToken {
                access_token,
                expires_at_ms,
            },
        );
        Ok(())
    }

    /// A valid access token, refreshed if less than 5 minutes remain.
    pub async fn access_token(&self, account_id: i64, provider: Provider) -> Result<String> {
        let mut cache = self.cache.lock().await;
        if let Some(tok) = cache.get(&account_id) {
            if tok.expires_at_ms - crate::models::now_ms() > 5 * 60 * 1000 {
                return Ok(tok.access_token.clone());
            }
        }
        let refreshed = self.refresh(account_id, provider).await?;
        cache.insert(account_id, refreshed.clone());
        Ok(refreshed.access_token)
    }

    /// Mint an access token for a *specific* resource scope (e.g. Microsoft
    /// Graph), separate from the cached mail token. Microsoft issues
    /// single-resource tokens, so the mail token cannot be reused against
    /// `graph.microsoft.com`; this runs a dedicated refresh-token grant with an
    /// explicit `scope` and returns the resulting (Graph-audience) token
    /// without disturbing the mail cache or the stored mail access token.
    ///
    /// The refresh token may be rotated by this grant; the new one is persisted
    /// (it stays multi-resource, so mail refresh keeps working). A rejected
    /// grant usually means the extra scope was never consented, surfaced as
    /// `NeedsReauth` so the caller can trigger incremental consent.
    pub async fn access_token_for_scope(
        &self,
        account_id: i64,
        provider: Provider,
        scope: &str,
    ) -> Result<String> {
        let cfg =
            for_provider(provider).ok_or_else(|| CoreError::Auth("not an oauth account".into()))?;
        let (client_id, client_secret) = crate::oauth::providers::resolve_credentials(provider)?;
        let refresh_token = credentials::load_async(account_id, Slot::RefreshToken).await?;

        let mut form = vec![
            ("grant_type".to_string(), "refresh_token".to_string()),
            ("refresh_token".to_string(), refresh_token),
            ("client_id".to_string(), client_id),
            // offline_access keeps a (rotated) refresh token coming back.
            ("scope".to_string(), format!("{scope} offline_access")),
        ];
        if let Some(cs) = client_secret {
            form.push(("client_secret".to_string(), cs));
        }

        let body = post_form(cfg.token_url, &form).await?;
        let tok: TokenResponse = serde_json::from_str(&body).map_err(|_| {
            // invalid_grant / consent_required => the scope was never granted.
            if body.contains("invalid_grant") || body.contains("AADSTS65001") {
                CoreError::NeedsReauth
            } else {
                CoreError::Auth(format!("scoped token request failed: {body}"))
            }
        })?;

        // Do NOT overwrite Slot::AccessToken (that is the mail token, a
        // different audience). Only persist the rotated refresh token.
        if let Some(rt) = tok.refresh_token {
            credentials::store_async(account_id, Slot::RefreshToken, rt).await?;
        }
        Ok(tok.access_token)
    }

    async fn refresh(&self, account_id: i64, provider: Provider) -> Result<CachedToken> {
        let cfg =
            for_provider(provider).ok_or_else(|| CoreError::Auth("not an oauth account".into()))?;
        let (client_id, client_secret) = crate::oauth::providers::resolve_credentials(provider)?;
        let refresh_token = credentials::load_async(account_id, Slot::RefreshToken).await?;

        let mut form = vec![
            ("grant_type".to_string(), "refresh_token".to_string()),
            ("refresh_token".to_string(), refresh_token),
            ("client_id".to_string(), client_id),
        ];
        if let Some(cs) = client_secret {
            form.push(("client_secret".to_string(), cs));
        }

        let body = post_form(cfg.token_url, &form).await?;
        let tok: TokenResponse = serde_json::from_str(&body).map_err(|_| {
            if body.contains("invalid_grant") {
                CoreError::NeedsReauth
            } else {
                CoreError::Auth(format!("token refresh failed: {body}"))
            }
        })?;

        if let Some(rt) = tok.refresh_token {
            credentials::store_async(account_id, Slot::RefreshToken, rt).await?;
        }
        credentials::store_async(account_id, Slot::AccessToken, tok.access_token.clone()).await?;
        Ok(CachedToken {
            access_token: tok.access_token,
            expires_at_ms: crate::models::now_ms()
                + tok.expires_in.unwrap_or(3600).saturating_sub(60) * 1000,
        })
    }
}

/// Tiny HTTPS form POST over rustls (avoids pulling in a full HTTP client).
pub async fn post_form(url: &str, form: &[(String, String)]) -> Result<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let parsed = url::Url::parse(url).map_err(|e| CoreError::Auth(e.to_string()))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| CoreError::Auth("bad token url".into()))?
        .to_string();
    let port = parsed.port().unwrap_or(443);
    let path = parsed.path().to_string();

    let body: String = form
        .iter()
        .map(|(k, v)| format!("{}={}", urlencode(k), urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");

    tracing::debug!(%host, port, %path, body_len = body.len(), "oauth: token POST: connecting");
    let tcp = tokio::net::TcpStream::connect((host.as_str(), port))
        .await
        .inspect_err(|e| {
            tracing::warn!(%host, port, error = %e, kind = ?e.kind(), "oauth: token POST: TCP connect failed")
        })?;
    tracing::debug!(%host, "oauth: token POST: TCP connected, starting TLS handshake");

    let connector = crate::imap::tls_connector();
    let server_name = rustls::pki_types::ServerName::try_from(host.clone())
        .map_err(|e| CoreError::Tls(e.to_string()))?;
    let mut stream = connector
        .connect(server_name, tcp)
        .await
        .map_err(|e| {
            tracing::warn!(%host, error = %e, kind = ?e.kind(), "oauth: token POST: TLS handshake failed");
            CoreError::Tls(e.to_string())
        })?;
    tracing::debug!(%host, "oauth: token POST: TLS established, sending request");

    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).await.inspect_err(|e| {
        tracing::warn!(%host, error = %e, kind = ?e.kind(), "oauth: token POST: request write failed")
    })?;

    // Token endpoints send `Connection: close` and often drop the socket WITHOUT
    // a TLS close_notify alert. rustls surfaces that abrupt close as an
    // `UnexpectedEof` io error even though the full HTTP response already
    // arrived - so treat UnexpectedEof as a clean end-of-stream once we have
    // bytes instead of failing the exchange. (Previously this bubbled up as
    // `CoreError::Io` -> the misleading "File system error" toast.)
    let mut resp = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match stream.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => resp.extend_from_slice(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof && !resp.is_empty() => {
                tracing::debug!(
                    %host,
                    bytes = resp.len(),
                    "oauth: token POST: server closed without close_notify; response already complete"
                );
                break;
            }
            Err(e) => {
                tracing::warn!(%host, error = %e, kind = ?e.kind(), bytes = resp.len(), "oauth: token POST: read failed");
                return Err(e.into());
            }
        }
    }
    let resp = String::from_utf8_lossy(&resp);
    let status_line = resp.lines().next().unwrap_or("");
    tracing::debug!(%host, status = %status_line, total_bytes = resp.len(), "oauth: token POST: response received");
    // Split headers/body; handle chunked transfer crudely by taking the largest
    // {...} JSON span (token endpoints return small JSON bodies).
    let body_part = resp.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or(&resp);
    let json_start = body_part.find('{');
    let json_end = body_part.rfind('}');
    match (json_start, json_end) {
        (Some(s), Some(e)) if e > s => Ok(body_part[s..=e].to_string()),
        _ => Ok(body_part.to_string()),
    }
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
