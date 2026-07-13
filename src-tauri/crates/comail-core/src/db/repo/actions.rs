use crate::error::Result;
use crate::models::now_ms;
use rusqlite::{params, Connection, OptionalExtension, Row};

#[derive(Debug, Clone)]
pub struct PendingAction {
    pub id: i64,
    pub account_id: i64,
    pub kind: String,
    pub message_id: Option<i64>,
    pub thread_id: Option<i64>,
    pub payload: serde_json::Value,
    pub state: String,
    pub attempts: i64,
    pub not_before: Option<i64>,
    pub created_at: i64,
}

fn from_row(row: &Row) -> rusqlite::Result<PendingAction> {
    Ok(PendingAction {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        kind: row.get("kind")?,
        message_id: row.get("message_id")?,
        thread_id: row.get("thread_id")?,
        payload: serde_json::from_str(&row.get::<_, String>("payload")?)
            .unwrap_or(serde_json::Value::Null),
        state: row.get("state")?,
        attempts: row.get("attempts")?,
        not_before: row.get("not_before")?,
        created_at: row.get("created_at")?,
    })
}

pub fn enqueue(
    conn: &Connection,
    account_id: i64,
    kind: &str,
    message_id: Option<i64>,
    thread_id: Option<i64>,
    payload: &serde_json::Value,
    not_before: Option<i64>,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO pending_actions (account_id, kind, message_id, thread_id, payload, not_before, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            account_id,
            kind,
            message_id,
            thread_id,
            serde_json::to_string(payload)?,
            not_before,
            now_ms()
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Due actions for one account, oldest first.
pub fn due(conn: &Connection, account_id: i64, now: i64, limit: i64) -> Result<Vec<PendingAction>> {
    // cal_% actions belong to the CalDAV task, not the IMAP executor.
    let mut stmt = conn.prepare(
        "SELECT * FROM pending_actions
         WHERE account_id = ?1 AND state = 'pending' AND (not_before IS NULL OR not_before <= ?2)
           AND kind NOT LIKE 'cal!_%' ESCAPE '!'
         ORDER BY created_at ASC LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![account_id, now, limit], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Earliest future not_before across pending actions (for the scheduler).
/// Due CalDAV write actions (the calendar task's slice of the queue).
pub fn due_calendar(
    conn: &Connection,
    account_id: i64,
    now: i64,
    limit: i64,
) -> Result<Vec<PendingAction>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM pending_actions
         WHERE account_id = ?1 AND state = 'pending' AND (not_before IS NULL OR not_before <= ?2)
           AND kind LIKE 'cal!_%' ESCAPE '!'
         ORDER BY created_at ASC LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![account_id, now, limit], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn next_due_at(conn: &Connection) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT MIN(not_before) FROM pending_actions
             WHERE state = 'pending' AND not_before IS NOT NULL",
            [],
            |r| r.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten())
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<PendingAction>> {
    let mut stmt = conn.prepare("SELECT * FROM pending_actions WHERE id = ?1")?;
    Ok(stmt.query_row(params![id], from_row).optional()?)
}

pub fn set_state(conn: &Connection, id: i64, state: &str, error: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE pending_actions SET state = ?2, last_error = ?3,
                finished_at = CASE WHEN ?2 IN ('done','failed','cancelled') THEN ?4 ELSE finished_at END
         WHERE id = ?1",
        params![id, state, error, now_ms()],
    )?;
    Ok(())
}

/// Atomically claim a pending action for execution. Returns false if it was
/// cancelled (or otherwise transitioned) since being read - the executor must
/// skip it in that case.
pub fn try_claim(conn: &Connection, id: i64) -> Result<bool> {
    let n = conn.execute(
        "UPDATE pending_actions SET state = 'inflight' WHERE id = ?1 AND state = 'pending'",
        params![id],
    )?;
    Ok(n > 0)
}

/// Reset actions abandoned mid-flight (the app was killed/crashed while one was
/// executing) back to pending so they get retried. An `inflight` row can only be
/// orphaned at startup because no actor is running yet; left as-is it would be
/// invisible to `due()` and stick forever (e.g. a send stuck on "Sending…").
/// Returns how many were recovered.
pub fn recover_inflight(conn: &Connection) -> Result<usize> {
    let n = conn.execute(
        "UPDATE pending_actions SET state = 'pending', not_before = ?1
         WHERE state = 'inflight'",
        params![now_ms()],
    )?;
    Ok(n)
}

/// Make a still-pending action due immediately ("send now" / skip the undo
/// window). Returns the action's account_id so the caller can nudge that actor,
/// or None if it was already claimed/cancelled/sent.
pub fn expedite(conn: &Connection, id: i64) -> Result<Option<i64>> {
    let n = conn.execute(
        "UPDATE pending_actions SET not_before = ?2 WHERE id = ?1 AND state = 'pending'",
        params![id, now_ms()],
    )?;
    if n == 0 {
        return Ok(None);
    }
    Ok(conn
        .query_row(
            "SELECT account_id FROM pending_actions WHERE id = ?1",
            params![id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?)
}

/// Transition pending -> cancelled; returns false if it was no longer pending.
pub fn try_cancel(conn: &Connection, id: i64) -> Result<bool> {
    let n = conn.execute(
        "UPDATE pending_actions SET state = 'cancelled', finished_at = ?2
         WHERE id = ?1 AND state = 'pending'",
        params![id, now_ms()],
    )?;
    Ok(n > 0)
}

pub fn bump_attempt(conn: &Connection, id: i64, retry_at: i64, error: &str) -> Result<()> {
    conn.execute(
        "UPDATE pending_actions SET attempts = attempts + 1, state = 'pending',
                not_before = ?2, last_error = ?3
         WHERE id = ?1",
        params![id, retry_at, error],
    )?;
    Ok(())
}

/// Most recent undoable action (pending or just done, within the window).
pub fn last_undoable(conn: &Connection, since_ms: i64) -> Result<Option<PendingAction>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM pending_actions
         WHERE created_at >= ?1 AND state IN ('pending','inflight','done')
           AND kind IN ('archive','trash','spam','mark_read','mark_unread','star','unstar','snooze','send','move','add_label','remove_label')
         ORDER BY created_at DESC LIMIT 1",
    )?;
    Ok(stmt.query_row(params![since_ms], from_row).optional()?)
}

/// Is there any pending action referencing this message (local intent wins over remote flags)?
pub fn has_pending_for_message(conn: &Connection, message_id: i64) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pending_actions
         WHERE message_id = ?1 AND state IN ('pending','inflight')",
        params![message_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub fn gc(conn: &Connection, older_than_ms: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM pending_actions
         WHERE state IN ('done','cancelled') AND finished_at < ?1",
        params![older_than_ms],
    )?;
    Ok(())
}
