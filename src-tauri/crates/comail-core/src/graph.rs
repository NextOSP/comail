//! Minimal Microsoft Graph client. Currently just enough to mint a Teams
//! online meeting and hand back its join URL for insertion into a draft.
//!
//! Auth is a delegated (per-user) Graph access token obtained separately from
//! the mail token, see `oauth::tokens::TokenProvider::access_token_for_scope`.

use crate::error::{CoreError, Result};

/// A created Teams online meeting (only the fields we surface today).
pub struct OnlineMeeting {
    pub join_url: String,
}

#[derive(serde::Deserialize)]
struct OnlineMeetingResponse {
    // v1.0 returns `joinWebUrl`; older payloads used `joinUrl`. Accept either.
    #[serde(rename = "joinWebUrl", default)]
    join_web_url: Option<String>,
    #[serde(rename = "joinUrl", default)]
    join_url: Option<String>,
}

/// Create an ad-hoc Teams meeting via `POST /me/onlineMeetings`.
///
/// `start_ms`/`end_ms` are epoch milliseconds; Graph wants RFC 3339. The window
/// is advisory for an online meeting (the join URL stays valid regardless), but
/// a sensible start/end keeps it tidy in the organizer's Teams calendar.
pub async fn create_online_meeting(
    access_token: &str,
    subject: &str,
    start_ms: i64,
    end_ms: i64,
) -> Result<OnlineMeeting> {
    let start = rfc3339(start_ms)?;
    let end = rfc3339(end_ms)?;
    let payload = serde_json::json!({
        "subject": subject,
        "startDateTime": start,
        "endDateTime": end,
    })
    .to_string();

    let client = reqwest::Client::builder()
        .user_agent("comail-graph/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| CoreError::Network(format!("graph http client: {e}")))?;

    // reqwest is built without the `json` feature here, so set the body/headers
    // by hand rather than `.json()`.
    let resp = client
        .post("https://graph.microsoft.com/v1.0/me/onlineMeetings")
        .bearer_auth(access_token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|e| CoreError::Network(format!("graph request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        // Token rejected / missing consent: let the caller re-consent.
        return Err(CoreError::NeedsReauth);
    }
    if !status.is_success() {
        return Err(CoreError::Network(format!(
            "graph create meeting failed ({status}): {body}"
        )));
    }

    let parsed: OnlineMeetingResponse = serde_json::from_str(&body)
        .map_err(|e| CoreError::Other(format!("graph response parse: {e}: {body}")))?;
    let join_url = parsed
        .join_web_url
        .or(parsed.join_url)
        .filter(|u| !u.is_empty())
        .ok_or_else(|| CoreError::Other("graph meeting had no join URL".into()))?;
    Ok(OnlineMeeting { join_url })
}

fn rfc3339(ms: i64) -> Result<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339())
        .ok_or_else(|| CoreError::Other("invalid meeting timestamp".into()))
}
