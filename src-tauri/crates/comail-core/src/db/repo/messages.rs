use crate::error::{CoreError, Result};
use crate::mime::{MimePlan, PlannedAttachment};
use crate::models::*;
use rusqlite::{Connection, OptionalExtension, Row, params};

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
    /// Transmitting party misaligned with From: (see mime::resolve_via) -     /// email or bare DKIM domain, shown as "via" in the UI. None when the
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContentProgress {
    pub done: u64,
    pub total: u64,
    pub failed: u64,
}

/// Text-content cache progress. Local-only/orphaned rows cannot be fetched from
/// IMAP and therefore must not hold completion open forever.
pub fn content_progress(conn: &Connection, account_id: i64) -> Result<ContentProgress> {
    conn.query_row(
        "SELECT
           COALESCE(SUM(m.body_state = 'cached'), 0),
           COUNT(*),
           COALESCE(SUM(m.body_state != 'cached' AND sf.id IS NOT NULL), 0)
         FROM messages m
         JOIN folders f ON f.id = m.folder_id
         JOIN accounts a ON a.id = m.account_id
         LEFT JOIN sync_failures sf
           ON sf.stage = 'content' AND sf.message_id = m.id
         WHERE m.account_id = ?1 AND m.uid IS NOT NULL
           AND (a.provider = 'gmail' OR COALESCE(f.role, '') <> 'all')",
        params![account_id],
        |r| {
            Ok(ContentProgress {
                done: r.get::<_, i64>(0)? as u64,
                total: r.get::<_, i64>(1)? as u64,
                failed: r.get::<_, i64>(2)? as u64,
            })
        },
    )
    .map_err(Into::into)
}

/// Compatibility tuple used by the existing body worker.
pub fn body_progress(conn: &Connection, account_id: i64) -> Result<(u64, u64)> {
    let progress = content_progress(conn, account_id)?;
    Ok((progress.done, progress.total))
}

pub fn set_body_state(conn: &Connection, id: i64, state: &str) -> Result<()> {
    conn.execute(
        "UPDATE messages SET body_state = ?2 WHERE id = ?1",
        params![id, state],
    )?;
    Ok(())
}

pub fn set_mime_plan(conn: &Connection, id: i64, plan: Option<&MimePlan>) -> Result<()> {
    let json = plan.map(serde_json::to_string).transpose()?;
    let changed = conn.execute(
        "UPDATE messages SET mime_plan_json = ?2 WHERE id = ?1",
        params![id, json],
    )?;
    if changed == 0 {
        return Err(CoreError::NotFound(format!("message {id}")));
    }
    Ok(())
}

pub fn mime_plan(conn: &Connection, id: i64) -> Result<Option<MimePlan>> {
    let json: Option<String> = conn
        .query_row(
            "SELECT mime_plan_json FROM messages WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    json.map(|value| serde_json::from_str(&value))
        .transpose()
        .map_err(Into::into)
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

/// Requeue selective bodies that an older decoder persisted before undoing
/// their MIME transfer encoding. These rows are otherwise permanently stuck
/// at `cached`, so merely fixing the decoder would never revisit them.
///
/// The recovery is deliberately conservative: it only considers remotely
/// refetchable rows with no full-message raw cache, and requires either a
/// Base64 payload that decodes to HTML or many quoted-printable artifacts.
pub fn requeue_misdecoded_bodies(conn: &mut Connection) -> Result<Vec<i64>> {
    let ids = {
        let mut stmt = conn.prepare(
            "SELECT m.id, b.text_body, b.html_body, m.mime_plan_json
             FROM messages m
             JOIN message_bodies b ON b.message_id = m.id
             JOIN folders f ON f.id = m.folder_id
             JOIN accounts a ON a.id = m.account_id
             WHERE m.body_state = 'cached'
               AND m.folder_id IS NOT NULL
               AND m.uid IS NOT NULL
               AND m.raw_path IS NULL
               AND (a.provider = 'gmail' OR COALESCE(f.role, '') <> 'all')
               AND (
                 LOWER(COALESCE(m.mime_plan_json, '')) LIKE '%\"transfer_encoding\":\"base64\"%'
                 OR LOWER(COALESCE(m.mime_plan_json, '')) LIKE '%\"transfer_encoding\":\"quoted-printable\"%'
               )",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        let mut ids = Vec::new();
        for row in rows {
            let (id, text, html, plan_json) = row?;
            let plan = plan_json
                .as_deref()
                .and_then(|value| serde_json::from_str::<MimePlan>(value).ok());
            let has_any_base64 = plan.as_ref().is_some_and(|plan| {
                plan.text_sections
                    .iter()
                    .any(|section| section.transfer_encoding.eq_ignore_ascii_case("base64"))
            });
            let has_html_base64 = plan.as_ref().is_some_and(|plan| {
                plan.text_sections.iter().any(|section| {
                    section.kind == crate::mime::TextSectionKind::Html
                        && section.transfer_encoding.eq_ignore_ascii_case("base64")
                })
            });
            let has_plain_qp = plan.as_ref().is_some_and(|plan| {
                plan.text_sections.iter().any(|section| {
                    section.kind == crate::mime::TextSectionKind::Plain
                        && section
                            .transfer_encoding
                            .eq_ignore_ascii_case("quoted-printable")
                })
            });
            let has_html_qp = plan.as_ref().is_some_and(|plan| {
                plan.text_sections.iter().any(|section| {
                    section.kind == crate::mime::TextSectionKind::Html
                        && section
                            .transfer_encoding
                            .eq_ignore_ascii_case("quoted-printable")
                })
            });
            let bad_base64 = has_html_base64
                && html
                    .as_deref()
                    .is_some_and(crate::mime::looks_like_base64_encoded_html);
            // Version 2 introduced authoritative BODYSTRUCTURE Base64
            // decoding. Re-fetch every older selective Base64 text plan once,
            // including plain/calendar parts whose encoded form cannot be
            // distinguished safely from legitimate Base64-looking prose.
            let legacy_base64 = has_any_base64
                && plan
                    .as_ref()
                    .is_some_and(|plan| plan.version < crate::mime::MIME_PLAN_VERSION);
            let bad_quoted_printable = (has_plain_qp
                && text
                    .as_deref()
                    .is_some_and(crate::mime::looks_like_undecoded_quoted_printable))
                || (has_html_qp
                    && html
                        .as_deref()
                        .is_some_and(crate::mime::looks_like_undecoded_quoted_printable));
            if legacy_base64 || bad_base64 || bad_quoted_printable {
                ids.push(id);
            }
        }
        ids
    };

    if ids.is_empty() {
        return Ok(ids);
    }

    let tx = conn.transaction()?;
    let mut thread_ids = std::collections::BTreeSet::new();
    for &id in &ids {
        if let Some(thread_id) = tx.query_row(
            "SELECT thread_id FROM messages WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<i64>>(0),
        )? {
            thread_ids.insert(thread_id);
        }
        tx.execute(
            "DELETE FROM message_embeddings WHERE message_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM message_bodies WHERE message_id = ?1",
            params![id],
        )?;
        tx.execute(
            "UPDATE messages
             SET body_state = 'none', embedding_state = 'none', snippet = ''
             WHERE id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM sync_failures WHERE stage = 'content' AND message_id = ?1",
            params![id],
        )?;
        // Keep subject/address search available while the corrected body is
        // being fetched, but remove the stale encoded payload from FTS.
        super::search::index_message(&tx, id)?;
    }
    for thread_id in thread_ids {
        super::threads::recompute(&tx, thread_id)?;
    }
    tx.commit()?;
    Ok(ids)
}

/// Replace previews produced by the historical misuse of
/// `ammonia::clean_text`, which escapes HTML instead of extracting its text.
/// The SQL predicate keeps startup work small by loading bodies only for the
/// entity-heavy signature generated by that old code.
pub fn repair_escaped_html_snippets(conn: &mut Connection) -> Result<Vec<i64>> {
    let repairs = {
        let mut stmt = conn.prepare(
            "SELECT m.id, m.thread_id, m.snippet, b.text_body, b.html_body
             FROM messages m
             JOIN message_bodies b ON b.message_id = m.id
             WHERE m.body_state = 'cached'
               AND b.html_body IS NOT NULL
               AND (
                 m.snippet LIKE '%&#%'
                 OR m.snippet LIKE '%&lt;%'
                 OR m.snippet LIKE '%&gt;%'
                 OR m.snippet LIKE '%&quot;%'
                 OR m.snippet LIKE '%&apos;%'
                 OR m.snippet LIKE '%&grave;%'
                 OR m.snippet LIKE '%&amp;%'
               )",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        let mut repairs = Vec::new();
        for row in rows {
            let (id, thread_id, old_snippet, text, html) = row?;
            if text
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                continue;
            }
            let snippet = crate::mime::make_body_snippet(text.as_deref(), Some(&html));
            if snippet != old_snippet {
                repairs.push((id, thread_id, snippet));
            }
        }
        repairs
    };

    if repairs.is_empty() {
        return Ok(Vec::new());
    }

    let tx = conn.transaction()?;
    let mut ids = Vec::with_capacity(repairs.len());
    let mut thread_ids = std::collections::BTreeSet::new();
    for (id, thread_id, snippet) in repairs {
        tx.execute(
            "DELETE FROM message_embeddings WHERE message_id = ?1",
            params![id],
        )?;
        tx.execute(
            "UPDATE messages SET snippet = ?2, embedding_state = 'pending' WHERE id = ?1",
            params![id, snippet],
        )?;
        super::search::index_message(&tx, id)?;
        ids.push(id);
        if let Some(thread_id) = thread_id {
            thread_ids.insert(thread_id);
        }
    }
    for thread_id in thread_ids {
        super::threads::recompute(&tx, thread_id)?;
    }
    tx.commit()?;
    Ok(ids)
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
    #[derive(Debug)]
    struct Existing {
        id: i64,
        part_id: Option<String>,
        filename: Option<String>,
        mime_type: Option<String>,
        size: Option<i64>,
        content_id: Option<String>,
        has_file: bool,
        has_imap_section: bool,
    }

    let existing = {
        let mut stmt = conn.prepare(
            "SELECT id, part_id, filename, mime_type, size, content_id,
                    file_path IS NOT NULL, imap_section IS NOT NULL
             FROM attachments WHERE message_id = ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map(params![message_id], |row| {
            Ok(Existing {
                id: row.get(0)?,
                part_id: row.get(1)?,
                filename: row.get(2)?,
                mime_type: row.get(3)?,
                size: row.get(4)?,
                content_id: row.get(5)?,
                has_file: row.get::<_, i64>(6)? != 0,
                has_imap_section: row.get::<_, i64>(7)? != 0,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut used = std::collections::HashSet::new();

    for a in atts {
        // Full-message parsing uses attachment indexes while BODYSTRUCTURE
        // uses IMAP section ids. Match by the strongest immutable metadata so
        // an explicit-open fallback does not destroy planned row IDs or an
        // attachment file already cached on disk.
        let matched = existing
            .iter()
            .filter(|item| !used.contains(&item.id))
            .filter_map(|item| {
                let score = if a.part_id.is_some() && item.part_id.as_deref() == a.part_id {
                    Some(0)
                } else if a.content_id.is_some() && item.content_id.as_deref() == a.content_id {
                    Some(1)
                } else if a.filename.is_some()
                    && item.filename.as_deref() == a.filename
                    && (a.mime_type.is_none() || item.mime_type.as_deref() == a.mime_type)
                {
                    Some(2)
                } else if a.filename.is_none()
                    && a.content_id.is_none()
                    && item.filename.is_none()
                    && item.content_id.is_none()
                    && item.mime_type.as_deref() == a.mime_type
                    && item.size == a.size
                {
                    Some(3)
                } else {
                    None
                };
                score.map(|score| (score, item.id))
            })
            .min()
            .map(|(_, id)| id);

        if let Some(id) = matched {
            used.insert(id);
            conn.execute(
                "UPDATE attachments
                 SET part_id = ?2, filename = ?3, mime_type = ?4, size = ?5,
                     content_id = ?6, is_inline = ?7
                 WHERE id = ?1",
                params![
                    id,
                    a.part_id,
                    a.filename,
                    a.mime_type,
                    a.size,
                    a.content_id,
                    a.is_inline as i64,
                ],
            )?;
        } else {
            conn.execute(
                "INSERT INTO attachments (
                   message_id, part_id, filename, mime_type, size, content_id, is_inline
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    message_id,
                    a.part_id,
                    a.filename,
                    a.mime_type,
                    a.size,
                    a.content_id,
                    a.is_inline as i64,
                ],
            )?;
            used.insert(conn.last_insert_rowid());
        }
    }

    // Remove stale, uncached legacy-only descriptors. Planned IMAP rows and
    // downloaded files are intentionally retained if a quirky full parser
    // cannot match them; losing either would break stable UI IDs/offline use.
    for item in existing {
        if !used.contains(&item.id) && !item.has_file && !item.has_imap_section {
            conn.execute("DELETE FROM attachments WHERE id = ?1", params![item.id])?;
        }
    }
    Ok(())
}

pub fn set_attachment_imap_section(
    conn: &Connection,
    attachment_id: i64,
    imap_section: Option<&str>,
) -> Result<()> {
    let changed = conn.execute(
        "UPDATE attachments SET imap_section = ?2 WHERE id = ?1",
        params![attachment_id, imap_section],
    )?;
    if changed == 0 {
        return Err(CoreError::NotFound(format!("attachment {attachment_id}")));
    }
    Ok(())
}

pub fn attachment_by_imap_section(
    conn: &Connection,
    message_id: i64,
    imap_section: &str,
) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT id FROM attachments WHERE message_id = ?1 AND imap_section = ?2",
            params![message_id, imap_section],
            |row| row.get(0),
        )
        .optional()?)
}

/// Insert or refresh BODYSTRUCTURE attachment descriptors without replacing
/// rows. Stable IDs and already-downloaded `file_path` values are therefore
/// preserved across header re-syncs and plan upgrades.
///
/// Legacy rows have no `imap_section`; where possible they are adopted by
/// Content-ID, then by filename + MIME type, before a new row is inserted.
pub fn upsert_planned_attachments(
    conn: &Connection,
    message_id: i64,
    attachments: &[PlannedAttachment],
) -> Result<Vec<i64>> {
    let mut ids = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let existing = conn
            .query_row(
                "SELECT id FROM attachments
                 WHERE message_id = ?1 AND imap_section = ?2",
                params![message_id, attachment.section],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;

        let legacy = match existing {
            Some(id) => Some(id),
            None if attachment.content_id.is_some() => conn
                .query_row(
                    "SELECT id FROM attachments
                     WHERE message_id = ?1 AND imap_section IS NULL
                       AND content_id = ?2
                     ORDER BY (file_path IS NOT NULL) DESC, id
                     LIMIT 1",
                    params![message_id, attachment.content_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?,
            None => None,
        };
        let legacy = match legacy {
            Some(id) => Some(id),
            None if attachment.filename.is_some() => conn
                .query_row(
                    "SELECT id FROM attachments
                     WHERE message_id = ?1 AND imap_section IS NULL
                       AND filename = ?2
                       AND (mime_type = ?3 OR mime_type IS NULL)
                     ORDER BY (file_path IS NOT NULL) DESC, id
                     LIMIT 1",
                    params![message_id, attachment.filename, attachment.mime_type],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?,
            None => None,
        };

        let id = if let Some(id) = legacy {
            conn.execute(
                "UPDATE attachments
                 SET imap_section = ?2,
                     filename = COALESCE(?3, filename),
                     mime_type = COALESCE(?4, mime_type),
                     size = COALESCE(?5, size),
                     content_id = COALESCE(?6, content_id),
                     is_inline = ?7
                 WHERE id = ?1",
                params![
                    id,
                    attachment.section,
                    attachment.filename,
                    attachment.mime_type,
                    attachment.size as i64,
                    attachment.content_id,
                    attachment.is_inline as i64,
                ],
            )?;
            id
        } else {
            conn.execute(
                "INSERT INTO attachments (
                   message_id, filename, mime_type, size, content_id, is_inline, imap_section
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    message_id,
                    attachment.filename,
                    attachment.mime_type,
                    attachment.size as i64,
                    attachment.content_id,
                    attachment.is_inline as i64,
                    attachment.section,
                ],
            )?;
            conn.last_insert_rowid()
        };
        ids.push(id);
    }
    Ok(ids)
}

/// Remove a message that was expunged remotely.
pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM messages_fts WHERE rowid = ?1", params![id])
        .ok();
    conn.execute("DELETE FROM messages WHERE id = ?1", params![id])?;
    Ok(())
}

fn detail_from_row(row: &rusqlite::Row) -> rusqlite::Result<MessageDetail> {
    let subject: String = row.get("subject")?;
    let prefix: String = row.get("local_subject_prefix")?;
    let automation_note = row.get::<_, String>("local_body_note")?;
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
        subject: if prefix.is_empty() {
            subject
        } else {
            format!("{prefix}{subject}")
        },
        date: row.get("date")?,
        is_read: row.get::<_, i64>("is_read")? != 0,
        is_starred: row.get::<_, i64>("is_starred")? != 0,
        is_draft: row.get::<_, i64>("is_draft")? != 0,
        is_outgoing: row.get::<_, i64>("is_outgoing")? != 0,
        snippet: row.get("snippet")?,
        body_state: row.get("body_state")?,
        text_body: row.get("text_body")?,
        html_body: row.get("html_body")?,
        automation_note: (!automation_note.trim().is_empty()).then_some(automation_note),
        attachments: Vec::new(),
        list_unsubscribe: row.get("list_unsubscribe")?,
        via: row.get("sender_addr")?,
        send_state: row.get("send_state")?,
        send_error: row.get("send_error")?,
    })
}

/// Correlated-subquery columns that annotate a draft with the state of its
/// queued send action, so a stuck/failed send stays visible with its error
/// instead of looking like an ordinary draft. `NULL` for anything without an
/// active send action. Kept as a shared fragment so `detail` and
/// `list_for_thread` expose the same columns `detail_from_row` reads.
const SEND_STATE_COLS: &str = "
    (SELECT CASE WHEN pa.state = 'failed' OR pa.last_error IS NOT NULL
                 THEN 'failed' ELSE 'queued' END
     FROM pending_actions pa
     WHERE pa.message_id = m.id AND pa.kind = 'send'
       AND pa.state IN ('pending', 'inflight', 'failed')
     ORDER BY pa.id DESC LIMIT 1) AS send_state,
    (SELECT pa.last_error
     FROM pending_actions pa
     WHERE pa.message_id = m.id AND pa.kind = 'send'
       AND pa.state IN ('pending', 'inflight', 'failed')
     ORDER BY pa.id DESC LIMIT 1) AS send_error";

fn attachment_meta_from_row(
    row: &rusqlite::Row,
    first_col: usize,
) -> rusqlite::Result<AttachmentMeta> {
    Ok(AttachmentMeta {
        id: row.get(first_col)?,
        // Decode RFC 2047 encoded-words at read time so rows synced before the
        // BODYSTRUCTURE decode fix still display a readable name (idempotent for
        // already-clean values).
        filename: row
            .get::<_, Option<String>>(first_col + 1)?
            .map(|name| crate::mime::decode_encoded_words(&name)),
        mime_type: row.get(first_col + 2)?,
        size: row.get(first_col + 3)?,
        is_inline: row.get::<_, i64>(first_col + 4)? != 0,
    })
}

pub fn detail(conn: &Connection, id: i64) -> Result<MessageDetail> {
    let sql = format!(
        "SELECT m.*, b.text_body, b.html_body, {SEND_STATE_COLS}
         FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id
         WHERE m.id = ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut detail = stmt
        .query_row(params![id], detail_from_row)
        .optional()?
        .ok_or_else(|| CoreError::NotFound(format!("message {id}")))?;

    let mut astmt = conn.prepare(
        "SELECT id, filename, mime_type, size, is_inline FROM attachments WHERE message_id = ?1",
    )?;
    let atts = astmt.query_map(params![id], |row| attachment_meta_from_row(row, 0))?;
    for a in atts {
        detail.attachments.push(a?);
    }
    Ok(detail)
}

pub fn list_for_thread(conn: &Connection, thread_id: i64) -> Result<Vec<MessageDetail>> {
    let sql = format!(
        "SELECT m.*, b.text_body, b.html_body, {SEND_STATE_COLS}
         FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id
         WHERE m.thread_id = ?1
         ORDER BY m.date ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut out = stmt
        .query_map(params![thread_id], detail_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if out.is_empty() {
        return Ok(out);
    }

    let mut astmt = conn.prepare(
        "SELECT a.message_id, a.id, a.filename, a.mime_type, a.size, a.is_inline
         FROM attachments a JOIN messages m ON m.id = a.message_id
         WHERE m.thread_id = ?1",
    )?;
    let mut by_message: std::collections::HashMap<i64, Vec<AttachmentMeta>> =
        std::collections::HashMap::new();
    let atts = astmt.query_map(params![thread_id], |row| {
        Ok((row.get::<_, i64>(0)?, attachment_meta_from_row(row, 1)?))
    })?;
    for a in atts {
        let (mid, meta) = a?;
        by_message.entry(mid).or_default().push(meta);
    }
    for m in &mut out {
        if let Some(atts) = by_message.remove(&m.id) {
            m.attachments = atts;
        }
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
    missing_bodies_at(conn, folder_id, limit, now_ms())
}

fn missing_bodies_at(
    conn: &Connection,
    folder_id: i64,
    limit: i64,
    now: i64,
) -> Result<Vec<(i64, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.uid
         FROM messages m
         JOIN folders f ON f.id = m.folder_id
         JOIN accounts a ON a.id = m.account_id
         LEFT JOIN sync_failures sf
           ON sf.stage = 'content' AND sf.message_id = m.id
         WHERE m.folder_id = ?1 AND m.uid IS NOT NULL AND m.body_state = 'none'
           AND (a.provider = 'gmail' OR COALESCE(f.role, '') <> 'all')
           AND (sf.id IS NULL OR sf.next_retry_at IS NULL OR sf.next_retry_at <= ?3)
         ORDER BY m.date DESC LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![folder_id, limit, now], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{repo::sync_failures, testutil};

    /// The batched list_for_thread must return exactly what per-message
    /// detail() calls would, in date order, across the body/attachment
    /// combinations: cached body + attachments, cached body only, no body.
    #[test]
    fn list_for_thread_matches_per_message_detail() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (thread_id, first_id) = testutil::seed_message(&c, "a@test.dev", "Subject", false);
        let mut ids = vec![first_id];
        for i in 2..=3 {
            c.execute(
                "INSERT INTO messages (thread_id, account_id, folder_id, uid, message_id,
                 subject, from_addr, date, is_read, is_draft, is_outgoing)
                 VALUES (?1, 1, 1, ?2, 'mid-x-' || ?2, 'Subject', 'a@test.dev', ?3, 0, 0, 0)",
                params![thread_id, 100 + i, 1000 + i],
            )
            .unwrap();
            ids.push(c.last_insert_rowid());
        }
        store_body(
            &c,
            ids[0],
            Some("plain"),
            Some("<p>html</p>"),
            None,
            true,
            None,
        )
        .unwrap();
        store_body(&c, ids[1], Some("only text"), None, None, false, None).unwrap();
        // ids[2] stays body_state = 'none'.
        c.execute(
            "INSERT INTO attachments (message_id, filename, mime_type, size, is_inline, imap_section)
             VALUES (?1, 'a.png', 'image/png', 10, 1, '2'), (?1, 'b.pdf', 'application/pdf', 20, 0, '3')",
            params![ids[0]],
        )
        .unwrap();

        let batched = list_for_thread(&c, thread_id).unwrap();
        assert_eq!(batched.len(), 3);
        let looped: Vec<MessageDetail> =
            batched.iter().map(|m| detail(&c, m.id).unwrap()).collect();
        for (b, l) in batched.iter().zip(&looped) {
            assert_eq!(b.id, l.id);
            assert_eq!(b.text_body, l.text_body);
            assert_eq!(b.html_body, l.html_body);
            assert_eq!(b.body_state, l.body_state);
            assert_eq!(b.attachments.len(), l.attachments.len());
            for (ba, la) in b.attachments.iter().zip(&l.attachments) {
                assert_eq!(ba.id, la.id);
                assert_eq!(ba.filename, la.filename);
                assert_eq!(ba.is_inline, la.is_inline);
            }
        }
        // Date order preserved.
        let dates: Vec<i64> = batched.iter().map(|m| m.date).collect();
        let mut sorted = dates.clone();
        sorted.sort_unstable();
        assert_eq!(dates, sorted);
    }

    #[test]
    fn requeues_only_misdecoded_selective_bodies() {
        use base64::Engine;

        fn html_plan(encoding: &str) -> MimePlan {
            MimePlan {
                version: crate::mime::MIME_PLAN_VERSION,
                text_sections: vec![crate::mime::PlannedTextSection {
                    section: "1".into(),
                    kind: crate::mime::TextSectionKind::Html,
                    mime_type: "text/html".into(),
                    charset: Some("utf-8".into()),
                    transfer_encoding: encoding.into(),
                    size: 100,
                }],
                attachments: Vec::new(),
            }
        }

        let mut c = testutil::conn();
        testutil::seed_account(&c);
        let (_, base64_id) = testutil::seed_message(&c, "one@test.dev", "Base64", false);
        let (_, qp_id) = testutil::seed_message(&c, "two@test.dev", "QP", false);
        let (_, good_id) = testutil::seed_message(&c, "three@test.dev", "Good", false);
        let (_, skipped_all_id) = testutil::seed_message(&c, "four@test.dev", "Skipped All", false);
        let (_, legacy_plain_id) =
            testutil::seed_message(&c, "five@test.dev", "Legacy plain Base64", false);
        c.execute(
            "INSERT INTO folders (id, account_id, imap_name, role)
             VALUES (2, 1, 'All', 'all')",
            [],
        )
        .unwrap();
        c.execute(
            "UPDATE messages SET folder_id = 2 WHERE id = ?1",
            params![skipped_all_id],
        )
        .unwrap();

        let encoded = format!(
            "\n{}",
            base64::engine::general_purpose::STANDARD
                .encode(b"<html><body><p>Hello</p></body></html>")
        );
        let raw_qp = "<div style=3D\"x\">Qu=E1=BA=A3ng=20c=E1=BB=A7a=20b=E1=BA=A1n</div>";
        for (id, encoding, body) in [
            (base64_id, "base64", encoded.as_str()),
            (skipped_all_id, "base64", encoded.as_str()),
            (qp_id, "quoted-printable", raw_qp),
            (
                good_id,
                "base64",
                "<html><body>Already decoded</body></html>",
            ),
        ] {
            set_mime_plan(&c, id, Some(&html_plan(encoding))).unwrap();
            store_body(&c, id, None, Some(body), None, false, Some(body)).unwrap();
        }
        let legacy_plain_plan = MimePlan {
            version: crate::mime::MIME_PLAN_VERSION - 1,
            text_sections: vec![crate::mime::PlannedTextSection {
                section: "1".into(),
                kind: crate::mime::TextSectionKind::Plain,
                mime_type: "text/plain".into(),
                charset: Some("utf-8".into()),
                transfer_encoding: "base64".into(),
                size: 100,
            }],
            attachments: Vec::new(),
        };
        set_mime_plan(&c, legacy_plain_id, Some(&legacy_plain_plan)).unwrap();
        store_body(
            &c,
            legacy_plain_id,
            Some("Already decoded but produced by the old Base64 path"),
            None,
            None,
            false,
            Some("Already decoded but produced by the old Base64 path"),
        )
        .unwrap();
        c.execute(
            "UPDATE messages SET embedding_state = 'done' WHERE id IN (?1, ?2, ?3)",
            params![base64_id, qp_id, legacy_plain_id],
        )
        .unwrap();
        for id in [base64_id, qp_id, legacy_plain_id] {
            c.execute(
                "INSERT INTO message_embeddings (message_id, chunk_index, model_id, dim, vec)
                 VALUES (?1, 0, 'test', 1, X'00000000')",
                params![id],
            )
            .unwrap();
            sync_failures::record_content_at(&c, id, Some(i64::MAX), "old", 1).unwrap();
        }

        let mut repaired = requeue_misdecoded_bodies(&mut c).unwrap();
        repaired.sort_unstable();
        let mut expected = vec![base64_id, qp_id, legacy_plain_id];
        expected.sort_unstable();
        assert_eq!(repaired, expected);

        for id in [base64_id, qp_id, legacy_plain_id] {
            let state: (String, String, String) = c
                .query_row(
                    "SELECT body_state, embedding_state, snippet FROM messages WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(state, ("none".into(), "none".into(), String::new()));
            assert_eq!(
                c.query_row(
                    "SELECT COUNT(*) FROM message_bodies WHERE message_id = ?1",
                    params![id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
                0
            );
            assert_eq!(
                c.query_row(
                    "SELECT COUNT(*) FROM message_embeddings WHERE message_id = ?1",
                    params![id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
                0
            );
            assert!(
                sync_failures::due_content(&c, 1, i64::MAX, 20)
                    .unwrap()
                    .iter()
                    .all(|failure| failure.message_id != Some(id))
            );
        }

        let good: (String, String) = c
            .query_row(
                "SELECT m.body_state, b.html_body
                 FROM messages m JOIN message_bodies b ON b.message_id = m.id
                 WHERE m.id = ?1",
                params![good_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(good.0, "cached");
        assert!(good.1.contains("Already decoded"));
        assert_eq!(
            c.query_row(
                "SELECT body_state FROM messages WHERE id = ?1",
                params![skipped_all_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "cached"
        );
    }

    #[test]
    fn repairs_escaped_html_snippets_and_derived_indexes() {
        let mut c = testutil::conn();
        testutil::seed_account(&c);
        let (thread_id, message_id) =
            testutil::seed_message(&c, "sender@test.dev", "HTML preview", false);
        let html = "\n<div style=\"font-weight:bold\">Dear <b>Alice</b> &amp; Bob<br>Welcome</div>";
        let escaped = crate::mime::make_snippet(&ammonia::clean_text(html));
        assert!(escaped.contains("&#10;"));
        assert!(escaped.contains("&lt;div"));
        store_body(
            &c,
            message_id,
            None,
            Some(html),
            None,
            false,
            Some(&escaped),
        )
        .unwrap();
        c.execute(
            "UPDATE messages SET embedding_state = 'done' WHERE id = ?1",
            params![message_id],
        )
        .unwrap();
        c.execute(
            "INSERT INTO message_embeddings (message_id, chunk_index, model_id, dim, vec)
             VALUES (?1, 0, 'test', 1, X'00000000')",
            params![message_id],
        )
        .unwrap();
        c.execute(
            "UPDATE threads SET snippet = ?2 WHERE id = ?1",
            params![thread_id, escaped],
        )
        .unwrap();
        crate::db::repo::search::index_message(&c, message_id).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'font'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );

        // A real plaintext alternative remains authoritative even if its
        // stored preview happens to contain an entity-like token.
        let (_, plain_id) = testutil::seed_message(&c, "plain@test.dev", "Plain preview", false);
        store_body(
            &c,
            plain_id,
            Some("Keep &amp; exactly"),
            Some("<p>Do not use me</p>"),
            None,
            false,
            Some("Keep &amp; exactly"),
        )
        .unwrap();

        assert_eq!(
            repair_escaped_html_snippets(&mut c).unwrap(),
            vec![message_id]
        );
        let repaired: (String, String, String, String) = c
            .query_row(
                "SELECT m.snippet, m.embedding_state, m.body_state, b.html_body
                 FROM messages m JOIN message_bodies b ON b.message_id = m.id
                 WHERE m.id = ?1",
                params![message_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(repaired.0, "Dear Alice & Bob Welcome");
        assert_eq!(repaired.1, "pending");
        assert_eq!(repaired.2, "cached");
        assert_eq!(repaired.3, html);
        assert_eq!(
            c.query_row(
                "SELECT snippet FROM threads WHERE id = ?1",
                params![thread_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "Dear Alice & Bob Welcome"
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM message_embeddings WHERE message_id = ?1",
                params![message_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'font'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'Alice'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
        assert_eq!(
            c.query_row(
                "SELECT snippet FROM messages WHERE id = ?1",
                params![plain_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "Keep &amp; exactly"
        );
        assert!(repair_escaped_html_snippets(&mut c).unwrap().is_empty());
    }

    #[test]
    fn content_progress_counts_only_remotely_fetchable_messages() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (_, cached_id) = testutil::seed_message(&c, "one@test.dev", "Cached", false);
        let (_, missing_id) = testutil::seed_message(&c, "two@test.dev", "Missing", false);
        c.execute(
            "UPDATE messages SET body_state = 'cached' WHERE id = ?1",
            params![cached_id],
        )
        .unwrap();
        // Neither local drafts nor rows detached from a remote UID are
        // actionable by the body/content pool.
        c.execute(
            "INSERT INTO messages (account_id, subject, date, is_draft, folder_id, uid)
             VALUES (1, 'Local', 1, 1, NULL, NULL),
                    (1, 'No UID', 2, 0, 1, NULL)",
            [],
        )
        .unwrap();
        // Generic IMAP accounts intentionally skip a special-use All folder;
        // rows left there by an older build must not hold progress open.
        c.execute_batch(
            "INSERT INTO folders (id, account_id, imap_name, role)
             VALUES (2, 1, 'All', 'all');
             INSERT INTO messages (account_id, subject, date, folder_id, uid)
             VALUES (1, 'Skipped duplicate', 3, 2, 9)",
        )
        .unwrap();
        sync_failures::record_content_at(&c, missing_id, None, "decode", 10).unwrap();

        assert_eq!(
            content_progress(&c, 1).unwrap(),
            ContentProgress {
                done: 1,
                total: 2,
                failed: 1,
            }
        );
        assert_eq!(body_progress(&c, 1).unwrap(), (1, 2));
    }

    #[test]
    fn missing_bodies_obeys_content_retry_deadlines_and_all_folder_policy() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (_, no_failure) = testutil::seed_message(&c, "one@test.dev", "No failure", false);
        let (_, future) = testutil::seed_message(&c, "two@test.dev", "Future retry", false);
        let (_, due) = testutil::seed_message(&c, "three@test.dev", "Due retry", false);
        let (_, no_deadline) =
            testutil::seed_message(&c, "four@test.dev", "Retry without deadline", false);
        const NOW: i64 = 1_000;
        sync_failures::record_content_at(&c, future, Some(NOW + 1), "fetch", 10).unwrap();
        sync_failures::record_content_at(&c, due, Some(NOW), "fetch", 10).unwrap();
        sync_failures::record_content_at(&c, no_deadline, None, "decode", 10).unwrap();

        let eligible = missing_bodies_at(&c, 1, 20, NOW).unwrap();
        let eligible: std::collections::HashSet<i64> =
            eligible.into_iter().map(|(id, _)| id).collect();
        assert_eq!(
            eligible,
            std::collections::HashSet::from([no_failure, due, no_deadline])
        );
        assert!(!eligible.contains(&future));

        // Generic IMAP accounts must not download duplicate content from the
        // special-use All folder. Gmail keeps All Mail as its canonical copy.
        c.execute(
            "INSERT INTO folders (id, account_id, imap_name, role)
             VALUES (2, 1, 'All', 'all')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO messages (account_id, folder_id, uid, subject, date)
             VALUES (1, 2, 99, 'All copy', 2)",
            [],
        )
        .unwrap();
        assert!(missing_bodies_at(&c, 2, 20, NOW).unwrap().is_empty());
        c.execute("UPDATE accounts SET provider = 'gmail' WHERE id = 1", [])
            .unwrap();
        assert_eq!(missing_bodies_at(&c, 2, 20, NOW).unwrap().len(), 1);
    }

    #[test]
    fn mime_plan_and_imap_section_roundtrip_without_replacing_legacy_ids() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (_, message_id) = testutil::seed_message(&c, "a@test.dev", "MIME", false);
        let plan = MimePlan {
            version: crate::mime::MIME_PLAN_VERSION,
            text_sections: vec![crate::mime::PlannedTextSection {
                section: "1".into(),
                kind: crate::mime::TextSectionKind::Plain,
                mime_type: "text/plain".into(),
                charset: Some("utf-8".into()),
                transfer_encoding: "quoted-printable".into(),
                size: 42,
            }],
            attachments: Vec::new(),
        };
        set_mime_plan(&c, message_id, Some(&plan)).unwrap();
        assert_eq!(mime_plan(&c, message_id).unwrap(), Some(plan.clone()));

        c.execute(
            "INSERT INTO attachments (message_id, part_id, filename, mime_type, file_path)
             VALUES (?1, 'legacy-2', 'a.pdf', 'application/pdf', '/cache/a.pdf')",
            params![message_id],
        )
        .unwrap();
        let attachment_id = c.last_insert_rowid();
        let planned = PlannedAttachment {
            section: "2".into(),
            filename: Some("a.pdf".into()),
            mime_type: "application/pdf".into(),
            size: 900,
            content_id: None,
            is_inline: false,
            transfer_encoding: "base64".into(),
        };
        assert_eq!(
            upsert_planned_attachments(&c, message_id, &[planned.clone()]).unwrap(),
            vec![attachment_id]
        );
        assert_eq!(
            upsert_planned_attachments(&c, message_id, &[planned]).unwrap(),
            vec![attachment_id]
        );
        assert_eq!(
            attachment_by_imap_section(&c, message_id, "2").unwrap(),
            Some(attachment_id)
        );
        replace_attachments(
            &c,
            message_id,
            &[NewAttachment {
                message_id,
                part_id: Some("0"),
                filename: Some("a.pdf"),
                mime_type: Some("application/pdf"),
                size: Some(900),
                content_id: None,
                is_inline: false,
            }],
        )
        .unwrap();
        let legacy: (String, String, i64) = c
            .query_row(
                "SELECT part_id, file_path, size FROM attachments WHERE id = ?1",
                params![attachment_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(legacy, ("0".into(), "/cache/a.pdf".into(), 900));
        assert_eq!(
            attachment_by_imap_section(&c, message_id, "2").unwrap(),
            Some(attachment_id)
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM attachments WHERE message_id = ?1",
                params![message_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn local_automation_annotations_are_exposed_without_rewriting_source_fields() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (_thread_id, message_id) =
            testutil::seed_message(&c, "billing@vendor.test", "July invoice", false);
        c.execute(
            "UPDATE messages SET local_subject_prefix = '[FINANCE] ',
                                 local_body_note = 'Send to accounts payable.'
             WHERE id = ?1",
            params![message_id],
        )
        .unwrap();

        let shown = detail(&c, message_id).unwrap();
        assert_eq!(shown.subject, "[FINANCE] July invoice");
        assert_eq!(
            shown.automation_note.as_deref(),
            Some("Send to accounts payable.")
        );
        let stored: String = c
            .query_row(
                "SELECT subject FROM messages WHERE id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, "July invoice");
    }
}
