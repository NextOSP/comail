use crate::error::Result;
use crate::models::FolderInfo;
use rusqlite::{Connection, OptionalExtension, Row, params};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoleSource {
    Legacy,
    Inbox,
    SpecialUse,
    GmailName,
    Name,
}

impl RoleSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Inbox => "inbox",
            Self::SpecialUse => "special_use",
            Self::GmailName => "gmail_name",
            Self::Name => "name",
        }
    }

    fn from_db(value: &str) -> Self {
        match value {
            "inbox" => Self::Inbox,
            "special_use" => Self::SpecialUse,
            "gmail_name" => Self::GmailName,
            "name" => Self::Name,
            _ => Self::Legacy,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetectedRole {
    pub role: &'static str,
    pub source: RoleSource,
}

#[derive(Debug, Clone)]
pub struct Folder {
    pub id: i64,
    pub account_id: i64,
    pub imap_name: String,
    pub delimiter: Option<String>,
    pub role: Option<String>,
    pub role_source: RoleSource,
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
        role_source: RoleSource::from_db(&row.get::<_, String>("role_source")?),
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
    upsert_role(
        conn,
        account_id,
        imap_name,
        delimiter,
        role,
        RoleSource::Legacy,
    )
}

pub fn upsert_detected(
    conn: &Connection,
    account_id: i64,
    imap_name: &str,
    delimiter: Option<&str>,
    detection: Option<DetectedRole>,
) -> Result<i64> {
    upsert_role(
        conn,
        account_id,
        imap_name,
        delimiter,
        detection.map(|d| d.role),
        detection.map_or(RoleSource::Legacy, |d| d.source),
    )
}

fn upsert_role(
    conn: &Connection,
    account_id: i64,
    imap_name: &str,
    delimiter: Option<&str>,
    role: Option<&str>,
    source: RoleSource,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO folders (account_id, imap_name, delimiter, role, role_source)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(account_id, imap_name)
         DO UPDATE SET delimiter = excluded.delimiter, role = excluded.role,
             role_source = CASE WHEN excluded.role_source = 'legacy' AND excluded.role IS folders.role
                                THEN folders.role_source ELSE excluded.role_source END",
        params![account_id, imap_name, delimiter, role, source.as_str()],
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

fn account_behavior(
    conn: &Connection,
    account_id: i64,
) -> Result<Box<dyn crate::provider::MailboxBehavior>> {
    let (provider, host): (String, String) = conn
        .query_row(
            "SELECT provider, imap_host FROM accounts WHERE id = ?1",
            [account_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .unwrap_or_default();
    Ok(crate::provider::behavior_for_account(&provider, &host))
}

/// Demote only conflicting Trash roles; other heuristic roles still scope mail views.
/// Call after a complete discovery batch, or inside the upgrade transaction.
pub fn normalize_roles(conn: &Connection, account_id: Option<i64>) -> Result<()> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT account_id FROM folders WHERE (?1 IS NULL OR account_id = ?1)")?;
    let accounts = stmt
        .query_map([account_id], |row| row.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in accounts {
        if !account_behavior(conn, id)?.requires_special_use_for_delete() {
            continue;
        }
        conn.execute(
            "INSERT INTO folder_role_repairs(folder_id, role)
             SELECT f.id, f.role FROM folders f
             WHERE f.account_id = ?1 AND f.role = 'trash'
               AND f.role_source NOT IN ('special_use', 'inbox')
               AND EXISTS (SELECT 1 FROM folders canonical
                   WHERE canonical.account_id = f.account_id AND canonical.role = f.role
                     AND canonical.role_source = 'special_use')
             ON CONFLICT(folder_id) DO NOTHING",
            [id],
        )?;
        conn.execute(
            "UPDATE folders SET role = NULL, role_source = 'legacy'
             WHERE account_id = ?1 AND role = 'trash'
               AND role_source NOT IN ('special_use', 'inbox')
               AND EXISTS (SELECT 1 FROM folders canonical
                   WHERE canonical.account_id = folders.account_id AND canonical.role = folders.role
                     AND canonical.role_source = 'special_use')",
            [id],
        )?;
    }
    Ok(())
}

/// Prefer server evidence over provider-approved names, never insertion order.
pub fn by_role(conn: &Connection, account_id: i64, role: &str) -> Result<Option<Folder>> {
    let behavior = account_behavior(conn, account_id)?;
    let mut stmt = conn.prepare("SELECT * FROM folders WHERE account_id = ?1 AND role = ?2")?;
    let rows = stmt.query_map(params![account_id, role], from_row)?;
    let mut candidates = Vec::new();
    for row in rows {
        let folder = row?;
        let rank = if role == "inbox" && folder.imap_name.eq_ignore_ascii_case("INBOX") {
            Some(4)
        } else if folder.role_source == RoleSource::SpecialUse {
            Some(3)
        } else {
            behavior.role_name_rank(&folder.imap_name)
        };
        if let Some(rank) = rank {
            candidates.push((rank, folder));
        }
    }
    if behavior.requires_special_use_for_delete()
        && candidates
            .iter()
            .any(|(_, folder)| folder.role_source == RoleSource::SpecialUse)
    {
        candidates.retain(|(_, folder)| folder.role_source == RoleSource::SpecialUse);
    }
    candidates.sort_by(|(ar, a), (br, b)| {
        br.cmp(ar)
            .then_with(|| {
                a.imap_name
                    .to_ascii_lowercase()
                    .cmp(&b.imap_name.to_ascii_lowercase())
            })
            .then_with(|| a.imap_name.cmp(&b.imap_name))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(candidates.into_iter().next().map(|(_, folder)| folder))
}

/// Destructive Gmail operations require fresh, persisted SPECIAL-USE evidence.
/// Legacy native roles still route ordinary moves safely while discovery runs.
pub fn is_permanent_delete_trash(conn: &Connection, folder_id: i64) -> Result<bool> {
    let Some(folder) = get(conn, folder_id)? else {
        return Ok(false);
    };
    if folder.role.as_deref() != Some(crate::models::roles::TRASH) {
        return Ok(false);
    }
    if account_behavior(conn, folder.account_id)?.requires_special_use_for_delete()
        && folder.role_source != RoleSource::SpecialUse
    {
        return Ok(false);
    }
    Ok(
        by_role(conn, folder.account_id, crate::models::roles::TRASH)?
            .is_some_and(|canonical| canonical.id == folder_id),
    )
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

#[cfg(test)]
#[path = "folders_tests.rs"]
mod tests;

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
