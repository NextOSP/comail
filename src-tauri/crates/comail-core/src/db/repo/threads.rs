use crate::error::Result;
use crate::models::*;
use rusqlite::{params, Connection, OptionalExtension, Row};

use super::parse_addrs;

fn summary_from_row(row: &Row) -> rusqlite::Result<ThreadSummary> {
    Ok(ThreadSummary {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        account_email: row.get("account_email")?,
        subject: row.get::<_, Option<String>>("subject")?.unwrap_or_default(),
        snippet: row.get("snippet")?,
        participants: parse_addrs(&row.get::<_, String>("participants_json")?),
        last_message_at: row.get("last_message_at")?,
        message_count: row.get("message_count")?,
        unread_count: row.get("unread_count")?,
        is_starred: row.get::<_, i64>("starred_count")? > 0,
        has_attachments: row.get::<_, i64>("attachment_count")? > 0,
        snoozed_until: row.get("snoozed_until")?,
        labels: parse_id_list(
            &row.get::<_, Option<String>>("label_ids")?
                .unwrap_or_default(),
        ),
    })
}

/// Parse a SQLite `group_concat` result ("1,3,5") into a list of ids.
fn parse_id_list(csv: &str) -> Vec<i64> {
    csv.split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect()
}

const SUMMARY_SELECT: &str = "
    SELECT t.id, t.account_id, a.email AS account_email,
           (SELECT m.subject FROM messages m WHERE m.thread_id = t.id ORDER BY m.date DESC LIMIT 1) AS subject,
           t.snippet, t.participants_json, t.last_message_at, t.message_count,
           t.unread_count, t.starred_count, t.attachment_count,
           s.wake_at AS snoozed_until,
           (SELECT group_concat(DISTINCT ml.label_id) FROM message_labels ml
              JOIN messages ml_m ON ml_m.id = ml.message_id
              WHERE ml_m.thread_id = t.id) AS label_ids
    FROM threads t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN snoozes s ON s.thread_id = t.id";

pub fn create(
    conn: &Connection,
    account_id: i64,
    gm_thrid: Option<&str>,
    subject_norm: &str,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO threads (account_id, gm_thrid, subject_norm) VALUES (?1,?2,?3)",
        params![account_id, gm_thrid, subject_norm],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn by_gm_thrid(conn: &Connection, account_id: i64, gm_thrid: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT id FROM threads WHERE account_id = ?1 AND gm_thrid = ?2 LIMIT 1",
            params![account_id, gm_thrid],
            |r| r.get(0),
        )
        .optional()?)
}

/// Thread that contains a message whose RFC Message-ID is in `refs`.
pub fn by_references(conn: &Connection, account_id: i64, refs: &[String]) -> Result<Option<i64>> {
    for r in refs {
        let hit: Option<i64> = conn
            .query_row(
                "SELECT m.thread_id FROM messages m
                 WHERE m.account_id = ?1 AND m.message_id = ?2 AND m.thread_id IS NOT NULL
                 LIMIT 1",
                params![account_id, r],
                |row| row.get(0),
            )
            .optional()?;
        if hit.is_some() {
            return Ok(hit);
        }
        // Also match messages that themselves referenced r (sibling replies).
        let hit: Option<i64> = conn
            .query_row(
                "SELECT m.thread_id FROM message_refs mr
                 JOIN messages m ON m.id = mr.message_id
                 WHERE m.account_id = ?1 AND mr.ref_message_id = ?2 AND m.thread_id IS NOT NULL
                 LIMIT 1",
                params![account_id, r],
                |row| row.get(0),
            )
            .optional()?;
        if hit.is_some() {
            return Ok(hit);
        }
    }
    Ok(None)
}

/// Subject fallback: same normalized subject, activity within the window.
pub fn by_subject(
    conn: &Connection,
    account_id: i64,
    subject_norm: &str,
    since_ms: i64,
) -> Result<Option<i64>> {
    if subject_norm.is_empty() {
        return Ok(None);
    }
    Ok(conn
        .query_row(
            "SELECT id FROM threads
             WHERE account_id = ?1 AND subject_norm = ?2 AND last_message_at >= ?3
             ORDER BY last_message_at DESC LIMIT 1",
            params![account_id, subject_norm, since_ms],
            |r| r.get(0),
        )
        .optional()?)
}

/// Recompute a thread's denormalized aggregates from its messages.
pub fn recompute(conn: &Connection, thread_id: i64) -> Result<()> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE thread_id = ?1",
            params![thread_id],
            |r| r.get(0),
        )
        .optional()?;
    if exists.unwrap_or(0) == 0 {
        conn.execute("DELETE FROM threads WHERE id = ?1", params![thread_id])?;
        return Ok(());
    }
    conn.execute(
        "UPDATE threads SET
            last_message_at = (SELECT COALESCE(MAX(date),0) FROM messages WHERE thread_id = ?1),
            message_count   = (SELECT COUNT(*) FROM messages WHERE thread_id = ?1),
            unread_count    = (SELECT COUNT(*) FROM messages WHERE thread_id = ?1 AND is_read = 0 AND is_draft = 0),
            starred_count   = (SELECT COUNT(*) FROM messages WHERE thread_id = ?1 AND is_starred = 1),
            attachment_count= (SELECT COUNT(*) FROM messages WHERE thread_id = ?1 AND has_attachments = 1),
            snippet         = COALESCE((SELECT snippet FROM messages WHERE thread_id = ?1 ORDER BY date DESC LIMIT 1), '')
         WHERE id = ?1",
        params![thread_id],
    )?;
    // Participants: distinct senders, most recent first, capped at 5.
    let mut stmt = conn.prepare(
        "SELECT from_name, from_addr, MAX(date) FROM messages
         WHERE thread_id = ?1 AND from_addr IS NOT NULL
         GROUP BY LOWER(from_addr) ORDER BY MAX(date) DESC LIMIT 5",
    )?;
    let parts = stmt
        .query_map(params![thread_id], |r| {
            Ok(Address {
                name: r.get(0)?,
                email: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    conn.execute(
        "UPDATE threads SET participants_json = ?2 WHERE id = ?1",
        params![thread_id, serde_json::to_string(&parts)?],
    )?;
    Ok(())
}

pub fn get_summary(conn: &Connection, thread_id: i64) -> Result<Option<ThreadSummary>> {
    let sql = format!("{SUMMARY_SELECT} WHERE t.id = ?1");
    let mut stmt = conn.prepare_cached(&sql)?;
    Ok(stmt
        .query_row(params![thread_id], summary_from_row)
        .optional()?)
}

/// Summaries for many threads in one query, returned in `thread_ids` order.
/// Ids that no longer exist are silently skipped. Plain `prepare` (not
/// cached): the placeholder arity varies per call and would pollute the
/// statement cache.
pub fn get_summaries(conn: &Connection, thread_ids: &[i64]) -> Result<Vec<ThreadSummary>> {
    if thread_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = thread_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!("{SUMMARY_SELECT} WHERE t.id IN ({placeholders})");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(thread_ids.iter()),
            summary_from_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut by_id: std::collections::HashMap<i64, ThreadSummary> =
        rows.into_iter().map(|t| (t.id, t)).collect();
    Ok(thread_ids
        .iter()
        .filter_map(|id| by_id.remove(id))
        .collect())
}

/// Which inbox tab to filter to. Overlay tabs (Split/AutoLabel) read the single
/// resolved `threads.routed_tab` so a thread appears in exactly one; the
/// Important/Other defaults catch everything still unrouted. Manual (user)
/// labels are a cross-cutting filter, not a routed tab.
pub enum TabFilter {
    Important,
    Other,
    Split(i64),
    AutoLabel(i64),
    ManualLabel(i64),
}

pub struct ListArgs {
    pub view: View,
    pub tab: Option<TabFilter>,
    pub account_id: Option<i64>,
    /// Restrict to threads with a message in this folder (user-folder view).
    pub folder_id: Option<i64>,
    pub cursor: Option<i64>,
    pub limit: i64,
}

/// Threads whose only incoming (non-draft, non-outgoing) messages are human.
const HUMAN_BUCKET: &str = "EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id
        AND m.is_draft = 0 AND m.is_outgoing = 0 AND m.is_automated = 0)
    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id
        AND m.is_draft = 0 AND m.is_outgoing = 0 AND m.is_automated = 1)";

/// Threads whose only incoming messages are automated.
const AUTO_BUCKET: &str = "EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id
        AND m.is_draft = 0 AND m.is_outgoing = 0 AND m.is_automated = 1)
    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id
        AND m.is_draft = 0 AND m.is_outgoing = 0 AND m.is_automated = 0)";

pub fn list(conn: &Connection, args: &ListArgs) -> Result<ThreadPage> {
    let mut where_clauses: Vec<String> = Vec::new();
    let mut bind: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    let role_exists = |role: &str, bind: &mut Vec<Box<dyn rusqlite::types::ToSql>>| {
        bind.push(Box::new(role.to_string()));
        format!(
            "EXISTS (SELECT 1 FROM messages m JOIN folders f ON f.id = m.folder_id
                     WHERE m.thread_id = t.id AND f.role = ?{})",
            bind.len()
        )
    };

    match args.view {
        View::Inbox => {
            let c = role_exists(roles::INBOX, &mut bind);
            where_clauses.push(c);
            where_clauses.push("s.thread_id IS NULL".into());
        }
        View::Starred => where_clauses.push("t.starred_count > 0".into()),
        View::Snoozed => where_clauses.push("s.thread_id IS NOT NULL".into()),
        View::Sent => {
            let c = role_exists(roles::SENT, &mut bind);
            where_clauses.push(c);
        }
        View::Drafts => where_clauses.push(
            "EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.is_draft = 1)".into(),
        ),
        View::Done => {
            let c = role_exists(roles::ARCHIVE, &mut bind);
            let inbox = role_exists(roles::INBOX, &mut bind);
            where_clauses.push(c);
            where_clauses.push(format!("NOT {inbox}"));
        }
        View::Trash => {
            let c = role_exists(roles::TRASH, &mut bind);
            where_clauses.push(c);
        }
        View::Spam => {
            let c = role_exists(roles::SPAM, &mut bind);
            where_clauses.push(c);
        }
        View::All => {}
    }

    if let Some(acc) = args.account_id {
        bind.push(Box::new(acc));
        where_clauses.push(format!("t.account_id = ?{}", bind.len()));
    }
    match &args.tab {
        Some(TabFilter::Important) => where_clauses.push(format!(
            "(t.routed_tab = 'important'
              OR ((t.routed_tab IS NULL OR t.routed_tab = 'pending') AND ({HUMAN_BUCKET})))"
        )),
        Some(TabFilter::Other) => where_clauses.push(format!(
            "(t.routed_tab = 'other'
              OR ((t.routed_tab IS NULL OR t.routed_tab = 'pending') AND ({AUTO_BUCKET})))"
        )),
        Some(TabFilter::Split(id)) => {
            bind.push(Box::new(format!("split:{id}")));
            where_clauses.push(format!("t.routed_tab = ?{}", bind.len()));
        }
        Some(TabFilter::AutoLabel(id)) => {
            bind.push(Box::new(format!("label:{id}")));
            where_clauses.push(format!("t.routed_tab = ?{}", bind.len()));
        }
        Some(TabFilter::ManualLabel(id)) => {
            bind.push(Box::new(*id));
            where_clauses.push(format!(
                "EXISTS (SELECT 1 FROM message_labels ml JOIN messages m ON m.id = ml.message_id
                         WHERE m.thread_id = t.id AND ml.label_id = ?{})",
                bind.len()
            ));
        }
        None => {}
    }
    if let Some(folder_id) = args.folder_id {
        bind.push(Box::new(folder_id));
        where_clauses.push(format!(
            "EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.folder_id = ?{})",
            bind.len()
        ));
    }
    if let Some(cur) = args.cursor {
        bind.push(Box::new(cur));
        where_clauses.push(format!("t.last_message_at < ?{}", bind.len()));
    }

    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_clauses.join(" AND "))
    };
    let sql = format!(
        "{SUMMARY_SELECT} {where_sql} ORDER BY t.last_message_at DESC LIMIT {}",
        args.limit + 1
    );

    let mut stmt = conn.prepare(&sql)?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let mut threads = stmt
        .query_map(params_ref.as_slice(), summary_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let next_cursor = if threads.len() as i64 > args.limit {
        threads.truncate(args.limit as usize);
        threads.last().map(|t| t.last_message_at)
    } else {
        None
    };
    Ok(ThreadPage {
        threads,
        next_cursor,
    })
}
