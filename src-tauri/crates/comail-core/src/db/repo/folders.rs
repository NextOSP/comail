use crate::error::Result;
use crate::models::FolderInfo;
use rusqlite::{params, Connection, OptionalExtension, Row};

#[derive(Debug, Clone)]
pub struct Folder {
    pub id: i64,
    pub account_id: i64,
    pub imap_name: String,
    pub delimiter: Option<String>,
    pub role: Option<String>,
    pub uidvalidity: Option<i64>,
    pub uidnext: Option<i64>,
    pub highestmodseq: Option<i64>,
    pub last_seen_uid: i64,
    pub backfill_cursor: Option<i64>,
    pub backfill_done: bool,
}

fn from_row(row: &Row) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        imap_name: row.get("imap_name")?,
        delimiter: row.get("delimiter")?,
        role: row.get("role")?,
        uidvalidity: row.get("uidvalidity")?,
        uidnext: row.get("uidnext")?,
        highestmodseq: row.get("highestmodseq")?,
        last_seen_uid: row.get("last_seen_uid")?,
        backfill_cursor: row.get("backfill_cursor")?,
        backfill_done: row.get::<_, i64>("backfill_done")? != 0,
    })
}

pub fn upsert(
    conn: &Connection,
    account_id: i64,
    imap_name: &str,
    delimiter: Option<&str>,
    role: Option<&str>,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO folders (account_id, imap_name, delimiter, role)
         VALUES (?1,?2,?3,?4)
         ON CONFLICT(account_id, imap_name)
         DO UPDATE SET delimiter = excluded.delimiter, role = excluded.role",
        params![account_id, imap_name, delimiter, role],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM folders WHERE account_id = ?1 AND imap_name = ?2",
        params![account_id, imap_name],
        |r| r.get(0),
    )?;
    Ok(id)
}

pub fn list(conn: &Connection, account_id: Option<i64>) -> Result<Vec<Folder>> {
    let mut out = Vec::new();
    match account_id {
        Some(id) => {
            let mut stmt = conn.prepare("SELECT * FROM folders WHERE account_id = ?1")?;
            let rows = stmt.query_map(params![id], from_row)?;
            for r in rows {
                out.push(r?);
            }
        }
        None => {
            let mut stmt = conn.prepare("SELECT * FROM folders")?;
            let rows = stmt.query_map([], from_row)?;
            for r in rows {
                out.push(r?);
            }
        }
    }
    Ok(out)
}

pub fn list_info(conn: &Connection, account_id: Option<i64>) -> Result<Vec<FolderInfo>> {
    Ok(list(conn, account_id)?
        .into_iter()
        .map(|f| FolderInfo {
            id: f.id,
            account_id: f.account_id,
            imap_name: f.imap_name,
            delimiter: f.delimiter,
            role: f.role,
        })
        .collect())
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Folder>> {
    let mut stmt = conn.prepare("SELECT * FROM folders WHERE id = ?1")?;
    Ok(stmt.query_row(params![id], from_row).optional()?)
}

pub fn by_role(conn: &Connection, account_id: i64, role: &str) -> Result<Option<Folder>> {
    let mut stmt =
        conn.prepare("SELECT * FROM folders WHERE account_id = ?1 AND role = ?2 LIMIT 1")?;
    Ok(stmt
        .query_row(params![account_id, role], from_row)
        .optional()?)
}

pub fn set_uid_state(
    conn: &Connection,
    id: i64,
    uidvalidity: Option<i64>,
    uidnext: Option<i64>,
    highestmodseq: Option<i64>,
) -> Result<()> {
    conn.execute(
        "UPDATE folders SET uidvalidity = ?2, uidnext = ?3, highestmodseq = ?4 WHERE id = ?1",
        params![id, uidvalidity, uidnext, highestmodseq],
    )?;
    Ok(())
}

pub fn set_last_seen_uid(conn: &Connection, id: i64, uid: i64) -> Result<()> {
    conn.execute(
        "UPDATE folders SET last_seen_uid = MAX(last_seen_uid, ?2) WHERE id = ?1",
        params![id, uid],
    )?;
    Ok(())
}

pub fn set_backfill(conn: &Connection, id: i64, cursor: Option<i64>, done: bool) -> Result<()> {
    conn.execute(
        "UPDATE folders SET backfill_cursor = ?2, backfill_done = ?3 WHERE id = ?1",
        params![id, cursor, done as i64],
    )?;
    Ok(())
}

/// UIDVALIDITY changed: drop all UID mappings for the folder (messages stay,
/// re-linked on next sync by Message-ID).
pub fn reset_uid_mappings(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE messages SET uid = NULL WHERE folder_id = ?1",
        params![id],
    )?;
    conn.execute(
        "UPDATE folders SET last_seen_uid = 0, uidnext = NULL, highestmodseq = NULL,
                            backfill_cursor = NULL, backfill_done = 0
         WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}
