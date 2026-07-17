//! Thread resolution: References/In-Reply-To first (JWZ-lite), then a
//! normalized-subject fallback within a 14-day window, else a new thread.

use crate::db::repo;
use crate::error::Result;
use crate::mime::{ParsedHeaders, normalize_subject};
use rusqlite::Connection;

const SUBJECT_WINDOW_MS: i64 = 14 * 24 * 3600 * 1000;

pub fn resolve_thread(
    conn: &Connection,
    account_id: i64,
    headers: &ParsedHeaders,
    date_ms: i64,
) -> Result<i64> {
    let subject_norm = normalize_subject(&headers.subject);

    if !headers.references.is_empty() {
        if let Some(tid) = repo::threads::by_references(conn, account_id, &headers.references)? {
            return Ok(tid);
        }
    }

    // Subject fallback only for replies (has Re:-style prefix stripped away
    // meaningfully) or when references exist but matched nothing yet.
    let looks_like_reply = normalize_subject(&headers.subject)
        != headers.subject.trim().to_lowercase()
        || !headers.references.is_empty();
    if looks_like_reply && !subject_norm.is_empty() {
        if let Some(tid) =
            repo::threads::by_subject(conn, account_id, &subject_norm, date_ms - SUBJECT_WINDOW_MS)?
        {
            return Ok(tid);
        }
    }

    repo::threads::create(conn, account_id, None, &subject_norm)
}
