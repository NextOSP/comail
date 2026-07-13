use crate::error::{CoreError, Result};
use crate::models::*;
use rusqlite::{params, Connection, OptionalExtension, Row};

use super::parse_addrs;

/// Parsed header data ready for insertion (produced by the sync engine).
#[derive(Debug, Clone)]
pub struct NewMessage {
    pub account_id: i64,
    pub folder_id: i64,
    pub uid: Option<i64>,
    pub message_id: Option<String>,
    pub gm_msgid: Option<String>,
    pub gm_thrid: Option<String>,
    pub subject: String,
    pub from: Option<Address>,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub date: i64,
    pub internal_date: Option<i64>,
    pub is_read: bool,
    pub is_starred: bool,
    pub is_draft: bool,
    pub is_outgoing: bool,
    pub is_automated: bool,
    pub has_attachments: bool,
    pub size: Option<i64>,
    pub snippet: String,
    pub references: Vec<String>,
    pub list_unsubscribe: Option<String>,
    /// Transmitting party misaligned with From: (see mime::resolve_via) —
    /// email or bare DKIM domain, shown as "via" in the UI. None when the
    /// transmitting domain aligns with From:.
    pub sender_addr: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MessageRow {
    pub id: i64,
    pub account_id: i64,
    pub thread_id: Option<i64>,
    pub folder_id: Option<i64>,
    pub uid: Option<i64>,
    pub message_id: Option<String>,
    pub subject: String,
    pub is_read: bool,
    pub is_starred: bool,
    pub body_state: String,
    pub raw_path: Option<String>,
}

fn row_basic(row: &Row) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        thread_id: row.get("thread_id")?,
        folder_id: row.get("folder_id")?,
        uid: row.get("uid")?,
        message_id: row.get("message_id")?,
        subject: row.get("subject")?,
        is_read: row.get::<_, i64>("is_read")? != 0,
        is_starred: row.get::<_, i64>("is_starred")? != 0,
        body_state: row.get("body_state")?,
        raw_path: row.get("raw_path")?,
    })
}

pub fn get_row(conn: &Connection, id: i64) -> Result<Option<MessageRow>> {
    let mut stmt = conn.prepare("SELECT * FROM messages WHERE id = ?1")?;
    Ok(stmt.query_row(params![id], row_basic).optional()?)
}

pub fn by_folder_uid(conn: &Connection, folder_id: i64, uid: i64) -> Result<Option<MessageRow>> {
    let mut stmt = conn.prepare("SELECT * FROM messages WHERE folder_id = ?1 AND uid = ?2")?;
    Ok(stmt
        .query_row(params![folder_id, uid], row_basic)
        .optional()?)
}

/// Find an existing message row for this account by RFC Message-ID (used to
/// re-link after UIDVALIDITY resets and to dedupe Gmail label-folders).
pub fn by_message_id(
    conn: &Connection,
    account_id: i64,
    message_id: &str,
) -> Result<Option<MessageRow>> {
    let mut stmt =
        conn.prepare("SELECT * FROM messages WHERE account_id = ?1 AND message_id = ?2 LIMIT 1")?;
    Ok(stmt
        .query_row(params![account_id, message_id], row_basic)
        .optional()?)
}

pub fn insert(conn: &Connection, m: &NewMessage, thread_id: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO messages (account_id, thread_id, folder_id, uid, message_id, gm_msgid, gm_thrid,
            subject, from_name, from_addr, to_json, cc_json, bcc_json, date, internal_date,
            is_read, is_starred, is_draft, is_outgoing, is_automated, has_attachments, size, snippet,
            list_unsubscribe, sender_addr)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)",
        params![
            m.account_id,
            thread_id,
            m.folder_id,
            m.uid,
            m.message_id,
            m.gm_msgid,
            m.gm_thrid,
            m.subject,
            m.from.as_ref().and_then(|a| a.name.clone()),
            m.from.as_ref().map(|a| a.email.clone()),
            serde_json::to_string(&m.to)?,
            serde_json::to_string(&m.cc)?,
            serde_json::to_string(&m.bcc)?,
            m.date,
            m.internal_date,
            m.is_read as i64,
            m.is_starred as i64,
            m.is_draft as i64,
            m.is_outgoing as i64,
            m.is_automated as i64,
            m.has_attachments as i64,
            m.size,
            m.snippet,
            m.list_unsubscribe,
            m.sender_addr,
        ],
    )?;
    let id = conn.last_insert_rowid();
    for r in &m.references {
        conn.execute(
            "INSERT OR IGNORE INTO message_refs (message_id, ref_message_id) VALUES (?1, ?2)",
            params![id, r],
        )?;
    }
    Ok(id)
}

pub fn set_uid_and_folder(
    conn: &Connection,
    id: i64,
    folder_id: i64,
    uid: Option<i64>,
) -> Result<()> {
    conn.execute(
        "UPDATE messages SET folder_id = ?2, uid = ?3 WHERE id = ?1",
        params![id, folder_id, uid],
    )?;
    Ok(())
}

pub fn set_flags(conn: &Connection, id: i64, is_read: bool, is_starred: bool) -> Result<()> {
    conn.execute(
        "UPDATE messages SET is_read = ?2, is_starred = ?3 WHERE id = ?1",
        params![id, is_read as i64, is_starred as i64],
    )?;
    Ok(())
}

pub fn set_read(conn: &Connection, id: i64, is_read: bool) -> Result<()> {
    conn.execute(
        "UPDATE messages SET is_read = ?2 WHERE id = ?1",
        params![id, is_read as i64],
    )?;
    Ok(())
}

pub fn set_starred(conn: &Connection, id: i64, is_starred: bool) -> Result<()> {
    conn.execute(
        "UPDATE messages SET is_starred = ?2 WHERE id = ?1",
        params![id, is_starred as i64],
    )?;
    Ok(())
}

/// (bodies cached, total messages) for an account - drives the "Sync x/total"
/// progress indicator while bodies backfill.
pub fn body_progress(conn: &Connection, account_id: i64) -> Result<(u64, u64)> {
    conn.query_row(
        "SELECT
           COALESCE(SUM(body_state = 'cached'), 0),
           COUNT(*)
         FROM messages WHERE account_id = ?1",
        params![account_id],
        |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64)),
    )
    .map_err(Into::into)
}

pub fn set_body_state(conn: &Connection, id: i64, state: &str) -> Result<()> {
    conn.execute(
        "UPDATE messages SET body_state = ?2 WHERE id = ?1",
        params![id, state],
    )?;
    Ok(())
}

pub fn store_body(
    conn: &Connection,
    id: i64,
    text_body: Option<&str>,
    html_body: Option<&str>,
    raw_path: Option<&str>,
    has_attachments: bool,
    snippet: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO message_bodies (message_id, text_body, html_body) VALUES (?1,?2,?3)
         ON CONFLICT(message_id) DO UPDATE SET text_body = excluded.text_body, html_body = excluded.html_body",
        params![id, text_body, html_body],
    )?;
    // Full text is now available: queue the message for semantic embedding.
    // Inference happens off the writer thread (see the embed worker), so this
    // only flips a cheap flag.
    conn.execute(
        "UPDATE messages SET body_state = 'cached', raw_path = COALESCE(?2, raw_path),
                has_attachments = ?3, snippet = COALESCE(?4, snippet),
                embedding_state = 'pending'
         WHERE id = ?1",
        params![id, raw_path, has_attachments as i64, snippet],
    )?;
    Ok(())
}

pub struct NewAttachment<'a> {
    pub message_id: i64,
    pub part_id: Option<&'a str>,
    pub filename: Option<&'a str>,
    pub mime_type: Option<&'a str>,
    pub size: Option<i64>,
    pub content_id: Option<&'a str>,
    pub is_inline: bool,
}

pub fn replace_attachments(
    conn: &Connection,
    message_id: i64,
    atts: &[NewAttachment],
) -> Result<()> {
    conn.execute(
        "DELETE FROM attachments WHERE message_id = ?1",
        params![message_id],
    )?;
    for a in atts {
        conn.execute(
            "INSERT INTO attachments (message_id, part_id, filename, mime_type, size, content_id, is_inline)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                a.message_id,
                a.part_id,
                a.filename,
                a.mime_type,
                a.size,
                a.content_id,
                a.is_inline as i64
            ],
        )?;
    }
    Ok(())
}

/// Remove a message that was expunged remotely.
pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM messages_fts WHERE rowid = ?1", params![id])
        .ok();
    conn.execute("DELETE FROM messages WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn detail(conn: &Connection, id: i64) -> Result<MessageDetail> {
    let mut stmt = conn.prepare(
        "SELECT m.*, b.text_body, b.html_body
         FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id
         WHERE m.id = ?1",
    )?;
    let mut detail = stmt
        .query_row(params![id], |row| {
            Ok(MessageDetail {
                id: row.get("id")?,
                thread_id: row.get::<_, Option<i64>>("thread_id")?.unwrap_or(0),
                account_id: row.get("account_id")?,
                from: Address {
                    name: row.get("from_name")?,
                    email: row
                        .get::<_, Option<String>>("from_addr")?
                        .unwrap_or_default(),
                },
                to: parse_addrs(&row.get::<_, String>("to_json")?),
                cc: parse_addrs(&row.get::<_, String>("cc_json")?),
                subject: row.get("subject")?,
                date: row.get("date")?,
                is_read: row.get::<_, i64>("is_read")? != 0,
                is_starred: row.get::<_, i64>("is_starred")? != 0,
                is_draft: row.get::<_, i64>("is_draft")? != 0,
                is_outgoing: row.get::<_, i64>("is_outgoing")? != 0,
                snippet: row.get("snippet")?,
                body_state: row.get("body_state")?,
                text_body: row.get("text_body")?,
                html_body: row.get("html_body")?,
                attachments: Vec::new(),
                list_unsubscribe: row.get("list_unsubscribe")?,
                via: row.get("sender_addr")?,
            })
        })
        .optional()?
        .ok_or_else(|| CoreError::NotFound(format!("message {id}")))?;

    let mut astmt = conn.prepare(
        "SELECT id, filename, mime_type, size, is_inline FROM attachments WHERE message_id = ?1",
    )?;
    let atts = astmt.query_map(params![id], |row| {
        Ok(AttachmentMeta {
            id: row.get(0)?,
            filename: row.get(1)?,
            mime_type: row.get(2)?,
            size: row.get(3)?,
            is_inline: row.get::<_, i64>(4)? != 0,
        })
    })?;
    for a in atts {
        detail.attachments.push(a?);
    }
    Ok(detail)
}

pub fn list_for_thread(conn: &Connection, thread_id: i64) -> Result<Vec<MessageDetail>> {
    let mut stmt =
        conn.prepare("SELECT id FROM messages WHERE thread_id = ?1 ORDER BY date ASC")?;
    let ids = stmt
        .query_map(params![thread_id], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        out.push(detail(conn, id)?);
    }
    Ok(out)
}

/// All (id, uid) pairs currently mapped in a folder - used for expunge reconciliation.
pub fn uids_in_folder(conn: &Connection, folder_id: i64) -> Result<Vec<(i64, i64)>> {
    let mut stmt =
        conn.prepare("SELECT id, uid FROM messages WHERE folder_id = ?1 AND uid IS NOT NULL")?;
    let rows = stmt
        .query_map(params![folder_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn max_uid_in_folder(conn: &Connection, folder_id: i64) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(uid), 0) FROM messages WHERE folder_id = ?1",
        params![folder_id],
        |r| r.get(0),
    )?)
}

/// The user's own sent messages with bodies, newest first - the corpus for
/// learning their writing voice. `(id, subject, text_body)`.
pub fn list_sent_bodies(
    conn: &Connection,
    account_id: Option<i64>,
    limit: i64,
) -> Result<Vec<(i64, String, String)>> {
    let (acc_sql, bind): (&str, Vec<Box<dyn rusqlite::types::ToSql>>) = match account_id {
        Some(id) => ("AND m.account_id = ?2", vec![Box::new(limit), Box::new(id)]),
        None => ("", vec![Box::new(limit)]),
    };
    let sql = format!(
        "SELECT m.id, m.subject, b.text_body
         FROM messages m
         JOIN folders f ON f.id = m.folder_id AND f.role = 'sent'
         JOIN message_bodies b ON b.message_id = m.id
         WHERE m.is_draft = 0 AND b.text_body IS NOT NULL AND b.text_body <> '' {acc_sql}
         ORDER BY m.date DESC LIMIT ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(params_ref.as_slice(), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Of `ids`, return those that are the user's own sent (non-draft) messages,
/// preserving the input order. Used to keep only self-authored few-shot hits.
pub fn filter_sent(conn: &Connection, ids: &[i64]) -> Result<Vec<i64>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let id_list = ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT m.id FROM messages m
         JOIN folders f ON f.id = m.folder_id AND f.role = 'sent'
         WHERE m.is_draft = 0 AND m.id IN ({id_list})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let sent: std::collections::HashSet<i64> = stmt
        .query_map([], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(ids.iter().copied().filter(|id| sent.contains(id)).collect())
}

/// Messages in a folder still lacking bodies, newest first.
pub fn missing_bodies(conn: &Connection, folder_id: i64, limit: i64) -> Result<Vec<(i64, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT id, uid FROM messages
         WHERE folder_id = ?1 AND uid IS NOT NULL AND body_state = 'none'
         ORDER BY date DESC LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![folder_id, limit], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
