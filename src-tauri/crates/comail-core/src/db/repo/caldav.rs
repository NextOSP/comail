//! CalDAV server config (one row per account) and discovered calendar
//! collections. Credentials never live here: generic-server app passwords go
//! to the keyring, Google rides the account's OAuth tokens.

use crate::error::Result;
use crate::models::Calendar;
use rusqlite::{params, Connection, OptionalExtension, Row};

#[derive(Debug, Clone)]
pub struct CaldavConfig {
    pub account_id: i64,
    /// "google" | "generic"
    pub kind: String,
    pub base_url: String,
    pub username: Option<String>,
    pub principal_url: Option<String>,
    pub home_set_url: Option<String>,
    pub enabled: bool,
    pub last_error: Option<String>,
}

fn config_row(row: &Row) -> rusqlite::Result<CaldavConfig> {
    Ok(CaldavConfig {
        account_id: row.get("account_id")?,
        kind: row.get("kind")?,
        base_url: row.get("base_url")?,
        username: row.get("username")?,
        principal_url: row.get("principal_url")?,
        home_set_url: row.get("home_set_url")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        last_error: row.get("last_error")?,
    })
}

fn calendar_row(row: &Row) -> rusqlite::Result<Calendar> {
    Ok(Calendar {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        url: row.get("url")?,
        display_name: row.get("display_name")?,
        color: row.get("color")?,
        read_only: row.get::<_, i64>("read_only")? != 0,
        enabled: row.get::<_, i64>("enabled")? != 0,
        is_default: row.get::<_, i64>("is_default")? != 0,
        last_synced_at: row.get("last_synced_at")?,
    })
}

pub fn upsert_config(conn: &Connection, cfg: &CaldavConfig) -> Result<()> {
    conn.execute(
        "INSERT INTO caldav_config
            (account_id, kind, base_url, username, principal_url, home_set_url, enabled, last_error)
         VALUES (?1,?2,?3,?4,?5,?6,?7,NULL)
         ON CONFLICT(account_id) DO UPDATE SET
            kind = excluded.kind, base_url = excluded.base_url,
            username = excluded.username, principal_url = excluded.principal_url,
            home_set_url = excluded.home_set_url, enabled = excluded.enabled,
            last_error = NULL",
        params![
            cfg.account_id,
            cfg.kind,
            cfg.base_url,
            cfg.username,
            cfg.principal_url,
            cfg.home_set_url,
            cfg.enabled as i64,
        ],
    )?;
    Ok(())
}

pub fn get_config(conn: &Connection, account_id: i64) -> Result<Option<CaldavConfig>> {
    conn.query_row(
        "SELECT * FROM caldav_config WHERE account_id = ?1",
        params![account_id],
        config_row,
    )
    .optional()
    .map_err(Into::into)
}

pub fn all_configs(conn: &Connection) -> Result<Vec<CaldavConfig>> {
    let mut stmt = conn.prepare("SELECT * FROM caldav_config WHERE enabled = 1")?;
    let rows = stmt
        .query_map([], config_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn set_config_error(conn: &Connection, account_id: i64, error: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE caldav_config SET last_error = ?2 WHERE account_id = ?1",
        params![account_id, error],
    )?;
    Ok(())
}

/// Drop the config and detach its events (they stay local; sync bookkeeping
/// is cleared so a later reconnect re-adopts them by UID).
pub fn delete_config(conn: &Connection, account_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE calendar_events SET calendar_id = NULL, caldav_href = NULL, etag = NULL,
                dirty = 0 WHERE account_id = ?1",
        params![account_id],
    )?;
    conn.execute(
        "DELETE FROM calendar_events WHERE account_id = ?1 AND deleted = 1",
        params![account_id],
    )?;
    conn.execute(
        "DELETE FROM calendars WHERE account_id = ?1",
        params![account_id],
    )?;
    conn.execute(
        "DELETE FROM caldav_config WHERE account_id = ?1",
        params![account_id],
    )?;
    Ok(())
}

/// Upsert a discovered collection; returns its id. Existing sync state
/// (ctag/sync_token/enabled) survives re-discovery.
pub fn upsert_calendar(
    conn: &Connection,
    account_id: i64,
    url: &str,
    display_name: Option<&str>,
    color: Option<&str>,
    read_only: bool,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO calendars (account_id, url, display_name, color, read_only)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(account_id, url) DO UPDATE SET
            display_name = excluded.display_name,
            color = excluded.color,
            read_only = excluded.read_only",
        params![account_id, url, display_name, color, read_only as i64],
    )?;
    conn.query_row(
        "SELECT id FROM calendars WHERE account_id = ?1 AND url = ?2",
        params![account_id, url],
        |r| r.get(0),
    )
    .map_err(Into::into)
}

pub fn list_calendars(conn: &Connection, account_id: Option<i64>) -> Result<Vec<Calendar>> {
    let mut out = Vec::new();
    match account_id {
        Some(id) => {
            let mut stmt =
                conn.prepare("SELECT * FROM calendars WHERE account_id = ?1 ORDER BY id")?;
            for row in stmt.query_map(params![id], calendar_row)? {
                out.push(row?);
            }
        }
        None => {
            let mut stmt = conn.prepare("SELECT * FROM calendars ORDER BY account_id, id")?;
            for row in stmt.query_map([], calendar_row)? {
                out.push(row?);
            }
        }
    }
    Ok(out)
}

pub fn get_calendar(conn: &Connection, calendar_id: i64) -> Result<Option<Calendar>> {
    conn.query_row(
        "SELECT * FROM calendars WHERE id = ?1",
        params![calendar_id],
        calendar_row,
    )
    .optional()
    .map_err(Into::into)
}

pub fn set_calendar_enabled(conn: &Connection, calendar_id: i64, enabled: bool) -> Result<()> {
    conn.execute(
        "UPDATE calendars SET enabled = ?2 WHERE id = ?1",
        params![calendar_id, enabled as i64],
    )?;
    Ok(())
}

/// Exactly one default (new-event target) per account.
pub fn set_default_calendar(conn: &Connection, account_id: i64, calendar_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE calendars SET is_default = (id = ?2) WHERE account_id = ?1",
        params![account_id, calendar_id],
    )?;
    Ok(())
}

pub fn default_calendar(conn: &Connection, account_id: i64) -> Result<Option<Calendar>> {
    conn.query_row(
        "SELECT * FROM calendars WHERE account_id = ?1 AND enabled = 1
         ORDER BY is_default DESC, id ASC LIMIT 1",
        params![account_id],
        calendar_row,
    )
    .optional()
    .map_err(Into::into)
}

pub fn set_sync_state(
    conn: &Connection,
    calendar_id: i64,
    ctag: Option<&str>,
    sync_token: Option<&str>,
    synced_at: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE calendars SET ctag = ?2, sync_token = ?3, last_synced_at = ?4 WHERE id = ?1",
        params![calendar_id, ctag, sync_token, synced_at],
    )?;
    Ok(())
}

/// (ctag, sync_token) as last stored.
pub fn sync_state(conn: &Connection, calendar_id: i64) -> Result<(Option<String>, Option<String>)> {
    conn.query_row(
        "SELECT ctag, sync_token FROM calendars WHERE id = ?1",
        params![calendar_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testutil;

    #[test]
    fn config_and_calendar_lifecycle() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        upsert_config(
            &c,
            &CaldavConfig {
                account_id: 1,
                kind: "generic".into(),
                base_url: "https://dav.example.com/".into(),
                username: Some("me".into()),
                principal_url: None,
                home_set_url: None,
                enabled: true,
                last_error: None,
            },
        )
        .unwrap();
        assert_eq!(all_configs(&c).unwrap().len(), 1);

        let a = upsert_calendar(
            &c,
            1,
            "https://dav.example.com/cal/a/",
            Some("A"),
            None,
            false,
        )
        .unwrap();
        let b = upsert_calendar(
            &c,
            1,
            "https://dav.example.com/cal/b/",
            Some("B"),
            None,
            true,
        )
        .unwrap();
        // Re-discovery keeps ids and sync state.
        set_sync_state(&c, a, Some("c1"), Some("t1"), 42).unwrap();
        let a2 = upsert_calendar(
            &c,
            1,
            "https://dav.example.com/cal/a/",
            Some("A2"),
            None,
            false,
        )
        .unwrap();
        assert_eq!(a, a2);
        assert_eq!(
            sync_state(&c, a).unwrap(),
            (Some("c1".into()), Some("t1".into()))
        );

        set_default_calendar(&c, 1, b).unwrap();
        assert_eq!(default_calendar(&c, 1).unwrap().unwrap().id, b);
        set_calendar_enabled(&c, b, false).unwrap();
        // Default falls back to an enabled calendar.
        assert_eq!(default_calendar(&c, 1).unwrap().unwrap().id, a);

        delete_config(&c, 1).unwrap();
        assert!(all_configs(&c).unwrap().is_empty());
        assert!(list_calendars(&c, Some(1)).unwrap().is_empty());
    }
}
