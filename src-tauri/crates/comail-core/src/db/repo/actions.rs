use crate::error::Result;
use crate::models::now_ms;
use rusqlite::{Connection, OptionalExtension, Row, params};

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
           AND NOT EXISTS (
               SELECT 1 FROM pending_actions predecessor
               WHERE predecessor.account_id = pending_actions.account_id
                 AND predecessor.message_id = pending_actions.message_id
                 AND predecessor.id < pending_actions.id
                 AND predecessor.state IN ('pending', 'inflight')
                 AND predecessor.kind NOT LIKE 'cal!_%' ESCAPE '!'
           )
         ORDER BY created_at ASC, id ASC LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![account_id, now, limit], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Whether one account has more IMAP/SMTP actions ready to execute now.
/// CalDAV actions are owned by the calendar task and intentionally excluded.
pub fn has_due(conn: &Connection, account_id: i64, now: i64) -> Result<bool> {
    Ok(!due(conn, account_id, now, 1)?.is_empty())
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
        "UPDATE pending_actions SET state = 'inflight'
         WHERE id = ?1 AND state = 'pending'
           AND NOT EXISTS (
               SELECT 1 FROM pending_actions predecessor
               WHERE predecessor.account_id = pending_actions.account_id
                 AND predecessor.message_id = pending_actions.message_id
                 AND predecessor.id < pending_actions.id
                 AND predecessor.state IN ('pending', 'inflight')
                 AND predecessor.kind NOT LIKE 'cal!_%' ESCAPE '!'
           )",
        params![id],
    )?;
    Ok(n > 0)
}

/// Reset actions abandoned mid-flight (the app was killed/crashed while one was
/// executing) back to pending so they get retried. This global recovery is
/// startup-only, before any actor is running. A live mutation worker must use
/// the account-scoped recovery under its exclusive lease instead.
/// Returns how many were recovered.
pub fn recover_inflight(conn: &Connection) -> Result<usize> {
    let n = conn.execute(
        "UPDATE pending_actions SET state = 'pending', not_before = ?1
         WHERE state = 'inflight'",
        params![now_ms()],
    )?;
    Ok(n)
}

/// Recover this account's abandoned mail mutations after a completed slice or
/// worker replacement. Caller must hold the exclusive mutation-worker lease
/// and have no remote command running. Calendar work belongs to another actor.
/// Preserve retry timing and payload identity, including remoteAttempted.
pub fn recover_account_inflight(conn: &Connection, account_id: i64) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE pending_actions SET state = 'pending'
         WHERE account_id = ?1 AND state = 'inflight'
           AND kind NOT LIKE 'cal!_%' ESCAPE '!'",
        params![account_id],
    )?)
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

/// Whether an optimistic move is still in flight from this folder. Header sync
/// uses this to avoid re-linking the old server copy to a row already moved
/// locally while the queued IMAP command is waiting to run.
pub fn has_active_move_from(conn: &Connection, message_id: i64, folder_id: i64) -> Result<bool> {
    let mut stmt = conn.prepare(
        "SELECT payload FROM pending_actions
         WHERE message_id = ?1
           AND kind IN ('archive','unarchive','trash','spam','not_spam','move')
           AND state IN ('pending','inflight')",
    )?;
    let payloads = stmt.query_map(params![message_id], |row| row.get::<_, String>(0))?;
    for payload in payloads {
        let payload: serde_json::Value = serde_json::from_str(&payload?)?;
        if payload["srcFolderId"].as_i64() == Some(folder_id) {
            return Ok(true);
        }
    }
    Ok(false)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testutil;

    #[test]
    fn live_recovery_is_scoped_and_preserves_retry_and_remote_identity() {
        let conn = testutil::conn();
        testutil::seed_account(&conn);
        conn.execute(
            "INSERT INTO accounts (id,email,provider,auth_kind,username,imap_host,imap_port,smtp_host,smtp_port,created_at)
             SELECT 2,'other@test.dev',provider,auth_kind,username,imap_host,imap_port,smtp_host,smtp_port,created_at FROM accounts WHERE id=1",
            [],
        ).unwrap();
        let payload = serde_json::json!({"remoteAttempted": true, "uid": 42});
        let stuck = enqueue(
            &conn,
            1,
            "delete_permanently",
            None,
            None,
            &payload,
            Some(123),
        )
        .unwrap();
        let other = enqueue(&conn, 2, "delete_permanently", None, None, &payload, None).unwrap();
        let calendar = enqueue(&conn, 1, "cal_create", None, None, &payload, None).unwrap();
        let pending = enqueue(&conn, 1, "delete_permanently", None, None, &payload, None).unwrap();
        let done = enqueue(&conn, 1, "delete_permanently", None, None, &payload, None).unwrap();
        for id in [stuck, other, calendar] {
            assert!(try_claim(&conn, id).unwrap());
        }
        bump_attempt(&conn, pending, 90_000, "retry later").unwrap();
        set_state(&conn, done, "done", None).unwrap();
        assert_eq!(recover_account_inflight(&conn, 1).unwrap(), 1);
        let recovered = get(&conn, stuck).unwrap().unwrap();
        assert_eq!(recovered.state, "pending");
        assert_eq!(recovered.not_before, Some(123));
        assert_eq!(recovered.payload, payload);
        assert_eq!(recovered.attempts, 0);
        assert_eq!(get(&conn, other).unwrap().unwrap().state, "inflight");
        assert_eq!(get(&conn, calendar).unwrap().unwrap().state, "inflight");
        assert_eq!(get(&conn, done).unwrap().unwrap().state, "done");
        let retry = get(&conn, pending).unwrap().unwrap();
        assert_eq!(retry.state, "pending");
        assert_eq!(retry.not_before, Some(90_000));
        assert_eq!(retry.attempts, 1);
        assert_eq!(retry.payload, payload);
        assert_eq!(recover_account_inflight(&conn, 1).unwrap(), 0);
    }

    #[test]
    fn retrying_move_blocks_later_mutations_only_for_its_message() {
        let conn = testutil::conn();
        testutil::seed_account(&conn);
        let (thread, message) = testutil::seed_message(&conn, "sender@test.dev", "move", false);
        let (_, other) = testutil::seed_message(&conn, "sender@test.dev", "other", false);
        let payload = serde_json::json!({});
        let first = enqueue(
            &conn,
            1,
            "move",
            Some(message),
            Some(thread),
            &payload,
            Some(20_000),
        )
        .unwrap();
        let second = enqueue(
            &conn,
            1,
            "delete_permanently",
            Some(message),
            Some(thread),
            &payload,
            None,
        )
        .unwrap();
        let independent = enqueue(&conn, 1, "star", Some(other), None, &payload, None).unwrap();
        assert_eq!(
            due(&conn, 1, 10_000, 20)
                .unwrap()
                .iter()
                .map(|a| a.id)
                .collect::<Vec<_>>(),
            vec![independent]
        );
        assert!(!try_claim(&conn, second).unwrap());
        assert!(try_claim(&conn, independent).unwrap());
        assert!(!try_claim(&conn, independent).unwrap());
        set_state(&conn, independent, "done", None).unwrap();
        assert!(!has_due(&conn, 1, 10_000).unwrap());
        assert!(try_claim(&conn, first).unwrap());
        assert!(!try_claim(&conn, second).unwrap());
        bump_attempt(&conn, first, 30_000, "uncertain move").unwrap();
        assert!(!try_claim(&conn, second).unwrap());
        set_state(&conn, first, "done", None).unwrap();
        assert!(try_claim(&conn, second).unwrap());
    }

    #[test]
    fn cancellation_and_startup_recovery_preserve_single_claim() {
        let conn = testutil::conn();
        testutil::seed_account(&conn);
        let id = enqueue(&conn, 1, "star", None, None, &serde_json::json!({}), None).unwrap();
        assert!(try_cancel(&conn, id).unwrap());
        assert!(!try_claim(&conn, id).unwrap());
        let id = enqueue(&conn, 1, "star", None, None, &serde_json::json!({}), None).unwrap();
        assert!(try_claim(&conn, id).unwrap());
        assert!(!try_cancel(&conn, id).unwrap());
        assert_eq!(recover_inflight(&conn).unwrap(), 1);
        assert!(try_claim(&conn, id).unwrap());
        assert!(!try_claim(&conn, id).unwrap());
    }

    #[test]
    fn due_is_stable_and_has_due_ignores_future_and_calendar_actions() {
        let conn = testutil::conn();
        testutil::seed_account(&conn);

        let later = enqueue(&conn, 1, "star", None, None, &serde_json::json!({}), None).unwrap();
        let first = enqueue(
            &conn,
            1,
            "archive",
            None,
            None,
            &serde_json::json!({}),
            None,
        )
        .unwrap();
        let future = enqueue(
            &conn,
            1,
            "trash",
            None,
            None,
            &serde_json::json!({}),
            Some(20_000),
        )
        .unwrap();
        let calendar = enqueue(
            &conn,
            1,
            "cal_create",
            None,
            None,
            &serde_json::json!({}),
            None,
        )
        .unwrap();

        // Force the same timestamp to exercise the id tie-breaker.
        conn.execute(
            "UPDATE pending_actions SET created_at = 1 WHERE id IN (?1, ?2)",
            params![later, first],
        )
        .unwrap();

        let ids: Vec<i64> = due(&conn, 1, 10_000, 20)
            .unwrap()
            .into_iter()
            .map(|action| action.id)
            .collect();
        assert_eq!(ids, vec![later, first]);
        assert!(has_due(&conn, 1, 10_000).unwrap());

        set_state(&conn, later, "done", None).unwrap();
        set_state(&conn, first, "done", None).unwrap();
        assert!(!has_due(&conn, 1, 10_000).unwrap());
        assert!(has_due(&conn, 1, 20_000).unwrap());

        let calendar_due = due_calendar(&conn, 1, 10_000, 20).unwrap();
        assert_eq!(calendar_due.len(), 1);
        assert_eq!(calendar_due[0].id, calendar);
        assert_eq!(future, due(&conn, 1, 20_000, 20).unwrap()[0].id);
    }
}
