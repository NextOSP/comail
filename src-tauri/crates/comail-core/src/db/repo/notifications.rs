use crate::error::{CoreError, Result};
use crate::models::now_ms;
use rusqlite::{params, Connection, OptionalExtension, Row};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationOutboxItem {
    pub id: i64,
    pub account_id: i64,
    pub message_id: i64,
    pub thread_id: Option<i64>,
    pub sender_name: Option<String>,
    pub sender_addr: Option<String>,
    pub subject: String,
    pub state: String,
    pub attempts: i64,
    pub not_before: Option<i64>,
    pub created_at: i64,
    pub claimed_at: Option<i64>,
    pub delivered_at: Option<i64>,
    pub suppressed_at: Option<i64>,
    pub suppression_reason: Option<String>,
    pub last_error: Option<String>,
}

fn from_row(row: &Row) -> rusqlite::Result<NotificationOutboxItem> {
    Ok(NotificationOutboxItem {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        message_id: row.get("message_id")?,
        thread_id: row.get("thread_id")?,
        sender_name: row.get("sender_name")?,
        sender_addr: row.get("sender_addr")?,
        subject: row.get("subject")?,
        state: row.get("state")?,
        attempts: row.get("attempts")?,
        not_before: row.get("not_before")?,
        created_at: row.get("created_at")?,
        claimed_at: row.get("claimed_at")?,
        delivered_at: row.get("delivered_at")?,
        suppressed_at: row.get("suppressed_at")?,
        suppression_reason: row.get("suppression_reason")?,
        last_error: row.get("last_error")?,
    })
}

/// Enqueue one notification by snapshotting the message fields needed by the
/// native dispatcher. Repeated calls for the same message return the original
/// outbox id and never reset a terminal delivery state.
pub fn enqueue(conn: &Connection, message_id: i64) -> Result<i64> {
    enqueue_at(conn, message_id, now_ms())
}

pub fn enqueue_at(conn: &Connection, message_id: i64, created_at: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO notification_outbox (
             account_id, message_id, thread_id, sender_name, sender_addr, subject, created_at
         )
         SELECT account_id, id, thread_id, from_name, from_addr, subject, ?2
         FROM messages WHERE id = ?1
         ON CONFLICT(message_id) DO NOTHING",
        params![message_id, created_at],
    )?;

    conn.query_row(
        "SELECT id FROM notification_outbox WHERE message_id = ?1",
        params![message_id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| CoreError::NotFound(format!("message {message_id}")))
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<NotificationOutboxItem>> {
    let mut stmt = conn.prepare("SELECT * FROM notification_outbox WHERE id = ?1")?;
    Ok(stmt.query_row(params![id], from_row).optional()?)
}

/// Pending notifications ready for dispatch, oldest first.
pub fn list_due(conn: &Connection, now: i64, limit: i64) -> Result<Vec<NotificationOutboxItem>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM notification_outbox
         WHERE state = 'pending' AND (not_before IS NULL OR not_before <= ?1)
         ORDER BY created_at, id LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![now, limit], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Claim a due row immediately before calling the native notification API.
/// Attempts count actual delivery starts rather than scheduling failures.
pub fn try_claim(conn: &Connection, id: i64, claimed_at: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE notification_outbox
         SET state = 'delivering', attempts = attempts + 1, claimed_at = ?2,
             last_error = NULL
         WHERE id = ?1 AND state = 'pending'
           AND (not_before IS NULL OR not_before <= ?2)",
        params![id, claimed_at],
    )? > 0)
}

pub fn mark_delivered(conn: &Connection, id: i64, delivered_at: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE notification_outbox
         SET state = 'delivered', delivered_at = ?2, not_before = NULL,
             last_error = NULL
         WHERE id = ?1 AND state IN ('pending','delivering')",
        params![id, delivered_at],
    )? > 0)
}

pub fn mark_suppressed(
    conn: &Connection,
    id: i64,
    suppressed_at: i64,
    reason: &str,
) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE notification_outbox
         SET state = 'suppressed', suppressed_at = ?2, suppression_reason = ?3,
             not_before = NULL, last_error = NULL
         WHERE id = ?1 AND state IN ('pending','delivering')",
        params![id, suppressed_at, reason],
    )? > 0)
}

pub fn retry(conn: &Connection, id: i64, retry_at: i64, error: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE notification_outbox
         SET state = 'pending', not_before = ?2, claimed_at = NULL, last_error = ?3
         WHERE id = ?1 AND state = 'delivering'",
        params![id, retry_at, error],
    )? > 0)
}

/// Recover a process crash after claim but before a terminal update.
pub fn recover_delivering(conn: &Connection, retry_at: i64) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE notification_outbox
         SET state = 'pending', not_before = ?1, claimed_at = NULL,
             last_error = COALESCE(last_error, 'delivery interrupted')
         WHERE state = 'delivering'",
        params![retry_at],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testutil;

    #[test]
    fn enqueue_is_unique_and_snapshots_message_fields() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (thread_id, message_id) =
            testutil::seed_message(&c, "alice@test.dev", "Deployment", false);
        c.execute(
            "UPDATE messages SET from_name = 'Alice' WHERE id = ?1",
            params![message_id],
        )
        .unwrap();

        let id = enqueue_at(&c, message_id, 100).unwrap();
        assert_eq!(enqueue_at(&c, message_id, 200).unwrap(), id);
        let row = get(&c, id).unwrap().unwrap();
        assert_eq!(row.account_id, 1);
        assert_eq!(row.thread_id, Some(thread_id));
        assert_eq!(row.sender_name.as_deref(), Some("Alice"));
        assert_eq!(row.sender_addr.as_deref(), Some("alice@test.dev"));
        assert_eq!(row.subject, "Deployment");
        assert_eq!(row.created_at, 100);
        assert_eq!(list_due(&c, 100, 10).unwrap().len(), 1);
    }

    #[test]
    fn claim_retry_delivery_and_recovery_are_durable() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (_, message_id) = testutil::seed_message(&c, "a@test.dev", "One", false);
        let id = enqueue_at(&c, message_id, 10).unwrap();

        assert!(try_claim(&c, id, 20).unwrap());
        assert!(!try_claim(&c, id, 20).unwrap());
        assert!(retry(&c, id, 50, "native service unavailable").unwrap());
        assert!(list_due(&c, 49, 10).unwrap().is_empty());
        assert_eq!(list_due(&c, 50, 10).unwrap()[0].attempts, 1);

        assert!(try_claim(&c, id, 50).unwrap());
        assert_eq!(recover_delivering(&c, 60).unwrap(), 1);
        assert!(try_claim(&c, id, 60).unwrap());
        assert!(mark_delivered(&c, id, 61).unwrap());
        let row = get(&c, id).unwrap().unwrap();
        assert_eq!(row.state, "delivered");
        assert_eq!(row.attempts, 3);
        assert_eq!(row.delivered_at, Some(61));
        assert!(list_due(&c, i64::MAX, 10).unwrap().is_empty());
    }

    #[test]
    fn suppression_is_terminal_and_message_delete_cascades() {
        let c = testutil::conn();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        testutil::seed_account(&c);
        let (_, message_id) = testutil::seed_message(&c, "a@test.dev", "Two", false);
        let id = enqueue_at(&c, message_id, 10).unwrap();
        assert!(mark_suppressed(&c, id, 11, "window focused").unwrap());
        let row = get(&c, id).unwrap().unwrap();
        assert_eq!(row.state, "suppressed");
        assert_eq!(row.suppression_reason.as_deref(), Some("window focused"));
        assert!(!mark_delivered(&c, id, 12).unwrap());

        c.execute("DELETE FROM messages WHERE id = ?1", params![message_id])
            .unwrap();
        assert!(get(&c, id).unwrap().is_none());
    }
}
