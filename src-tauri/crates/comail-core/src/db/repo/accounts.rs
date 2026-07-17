use crate::error::Result;
use crate::models::*;
use rusqlite::{Connection, OptionalExtension, Row, params};

fn account_from_row(row: &Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: row.get("id")?,
        email: row.get("email")?,
        display_name: row.get("display_name")?,
        provider: Provider::from_str(&row.get::<_, String>("provider")?),
        auth_kind: AuthKind::from_str(&row.get::<_, String>("auth_kind")?),
        sync_state: row.get("sync_state")?,
    })
}

fn config_from_row(row: &Row) -> rusqlite::Result<AccountConfig> {
    Ok(AccountConfig {
        id: row.get("id")?,
        email: row.get("email")?,
        display_name: row.get("display_name")?,
        provider: Provider::from_str(&row.get::<_, String>("provider")?),
        auth_kind: AuthKind::from_str(&row.get::<_, String>("auth_kind")?),
        username: row.get("username")?,
        imap_host: row.get("imap_host")?,
        imap_port: row.get::<_, i64>("imap_port")? as u16,
        smtp_host: row.get("smtp_host")?,
        smtp_port: row.get::<_, i64>("smtp_port")? as u16,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<Account>> {
    let mut stmt = conn.prepare("SELECT * FROM accounts ORDER BY id")?;
    let rows = stmt
        .query_map([], account_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn list_configs(conn: &Connection) -> Result<Vec<AccountConfig>> {
    let mut stmt = conn.prepare("SELECT * FROM accounts ORDER BY id")?;
    let rows = stmt
        .query_map([], config_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_config(conn: &Connection, id: i64) -> Result<Option<AccountConfig>> {
    let mut stmt = conn.prepare("SELECT * FROM accounts WHERE id = ?1")?;
    Ok(stmt.query_row(params![id], config_from_row).optional()?)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Account>> {
    let mut stmt = conn.prepare("SELECT * FROM accounts WHERE id = ?1")?;
    Ok(stmt.query_row(params![id], account_from_row).optional()?)
}

pub struct NewAccount<'a> {
    pub email: &'a str,
    pub display_name: Option<&'a str>,
    pub provider: Provider,
    pub auth_kind: AuthKind,
    pub username: &'a str,
    pub imap_host: &'a str,
    pub imap_port: u16,
    pub smtp_host: &'a str,
    pub smtp_port: u16,
}

pub fn insert(conn: &Connection, a: &NewAccount) -> Result<i64> {
    conn.execute(
        "INSERT INTO accounts (email, display_name, provider, auth_kind, username,
                               imap_host, imap_port, smtp_host, smtp_port, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            a.email,
            a.display_name,
            a.provider.as_str(),
            a.auth_kind.as_str(),
            a.username,
            a.imap_host,
            a.imap_port,
            a.smtp_host,
            a.smtp_port,
            now_ms()
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM accounts WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_sync_state(conn: &Connection, id: i64, state: &str) -> Result<()> {
    conn.execute(
        "UPDATE accounts SET sync_state = ?2 WHERE id = ?1",
        params![id, state],
    )?;
    Ok(())
}
