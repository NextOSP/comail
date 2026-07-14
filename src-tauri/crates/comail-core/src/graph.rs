//! Minimal Microsoft Graph client: mint a Teams online meeting, and write an
//! event into the user's Outlook / Microsoft 365 calendar (so it shows up in
//! Outlook and Teams).
//!
//! Auth is a delegated (per-user) Graph access token obtained separately from
//! the mail token, see `oauth::tokens::TokenProvider::access_token_for_scope`.

use crate::error::{CoreError, Result};

/// A created Teams online meeting (only the fields we surface today).
pub struct OnlineMeeting {
    pub join_url: String,
}

/// One attendee for a Graph calendar event.
pub struct GraphAttendee {
    pub email: String,
    pub name: Option<String>,
}

/// A calendar event to create in the user's Microsoft 365 calendar.
pub struct GraphEvent<'a> {
    pub subject: &'a str,
    pub body_html: Option<String>,
    pub location: Option<&'a str>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub all_day: bool,
    pub attendees: Vec<GraphAttendee>,
}

/// POST a JSON body to a Graph v1.0 path and return the parsed response.
/// `401`/`403` map to `NeedsReauth` so callers can trigger consent.
async fn post(
    access_token: &str,
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value> {
    let client = reqwest::Client::builder()
        .user_agent("comail-graph/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| CoreError::Network(format!("graph http client: {e}")))?;

    // reqwest is built without the `json` feature here, so set the body/headers
    // by hand rather than `.json()`.
    let resp = client
        .post(format!("https://graph.microsoft.com/v1.0{path}"))
        .bearer_auth(access_token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| CoreError::Network(format!("graph request failed: {e}")))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(CoreError::NeedsReauth);
    }
    if !status.is_success() {
        return Err(CoreError::Network(format!(
            "graph POST {path} failed ({status}): {text}"
        )));
    }
    serde_json::from_str(&text)
        .map_err(|e| CoreError::Other(format!("graph response parse: {e}: {text}")))
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
    let payload = serde_json::json!({
        "subject": subject,
        "startDateTime": rfc3339(start_ms)?,
        "endDateTime": rfc3339(end_ms)?,
    });
    let parsed = post(access_token, "/me/onlineMeetings", &payload).await?;
    // v1.0 returns `joinWebUrl`; older payloads used `joinUrl`. Accept either.
    let join_url = parsed
        .get("joinWebUrl")
        .or_else(|| parsed.get("joinUrl"))
        .and_then(|v| v.as_str())
        .filter(|u| !u.is_empty())
        .ok_or_else(|| CoreError::Other("graph meeting had no join URL".into()))?
        .to_string();
    Ok(OnlineMeeting { join_url })
}

/// Create an event in the user's default Microsoft 365 calendar via
/// `POST /me/events`. Times are sent in UTC (`timeZone: "UTC"`); Outlook/Teams
/// render them in the viewer's own timezone.
pub async fn create_calendar_event(access_token: &str, ev: &GraphEvent<'_>) -> Result<()> {
    let attendees: Vec<serde_json::Value> = ev
        .attendees
        .iter()
        .map(|a| {
            serde_json::json!({
                "emailAddress": { "address": a.email, "name": a.name },
                "type": "required",
            })
        })
        .collect();

    let mut payload = serde_json::json!({
        "subject": ev.subject,
        "isAllDay": ev.all_day,
        "start": { "dateTime": graph_datetime(ev.start_ms, ev.all_day)?, "timeZone": "UTC" },
        "end": { "dateTime": graph_datetime(ev.end_ms, ev.all_day)?, "timeZone": "UTC" },
        "attendees": attendees,
    });
    if let Some(html) = &ev.body_html {
        payload["body"] = serde_json::json!({ "contentType": "HTML", "content": html });
    }
    if let Some(loc) = ev.location {
        payload["location"] = serde_json::json!({ "displayName": loc });
    }

    post(access_token, "/me/events", &payload).await.map(|_| ())
}

fn rfc3339(ms: i64) -> Result<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339())
        .ok_or_else(|| CoreError::Other("invalid timestamp".into()))
}

/// Graph's `dateTime` field is a local-style ISO string paired with `timeZone`.
/// We pass UTC, so format the instant as `YYYY-MM-DDTHH:MM:SS`; all-day events
/// must sit on a midnight boundary.
fn graph_datetime(ms: i64, all_day: bool) -> Result<String> {
    let dt = chrono::DateTime::from_timestamp_millis(ms)
        .ok_or_else(|| CoreError::Other("invalid timestamp".into()))?;
    let fmt = if all_day {
        "%Y-%m-%dT00:00:00"
    } else {
        "%Y-%m-%dT%H:%M:%S"
    };
    Ok(dt.format(fmt).to_string())
}
