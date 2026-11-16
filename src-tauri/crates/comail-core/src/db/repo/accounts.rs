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
        imap_security: match row.get::<_, String>("imap_security")?.as_str() {
            "starttls" => ImapSecurity::Starttls,
            "tls" => ImapSecurity::Tls,
            _ => return Err(rusqlite::Error::InvalidQuery),
        },
        trusted_certificate: row.get("trusted_certificate")?,
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
    pub imap_security: ImapSecurity,
    pub trusted_certificate: Option<&'a str>,
}

pub fn insert(conn: &Connection, a: &NewAccount) -> Result<i64> {
    conn.execute(
        "INSERT INTO accounts (email, display_name, provider, auth_kind, username,
                               imap_host, imap_port, smtp_host, smtp_port, created_at,
                               imap_security, trusted_certificate)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
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
            now_ms(),
            a.imap_security.as_str(),
            a.trusted_certificate,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM accounts WHERE id = ?1", params![id])?;
    Ok(())
}

/// Longest sender name the app accepts; Gmail caps its own "Name" setting
/// at the same length.
pub const DISPLAY_NAME_MAX_CHARS: usize = 60;

/// The name shown in the From: header of mail sent from this account.
pub fn set_display_name(conn: &Connection, id: i64, name: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE accounts SET display_name = ?2 WHERE id = ?1",
        params![id, name],
    )?;
    Ok(())
}

pub fn set_sync_state(conn: &Connection, id: i64, state: &str) -> Result<()> {
    conn.execute(
        "UPDATE accounts SET sync_state = ?2 WHERE id = ?1",
        params![id, state],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testutil;

    #[test]
    fn saved_starttls_and_certificate_survive_reload_without_changing_other_accounts() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let certificate = include_str!("../../../tests/fixtures/tls/ca.pem");
        let id = insert(
            &c,
            &NewAccount {
                email: "bridge@example.test",
                display_name: None,
                provider: Provider::Imap,
                auth_kind: AuthKind::Password,
                username: "bridge@example.test",
                imap_host: "127.0.0.1",
                imap_port: 1143,
                smtp_host: "127.0.0.1",
                smtp_port: 1025,
                imap_security: ImapSecurity::Starttls,
                trusted_certificate: Some(certificate),
            },
        )
        .unwrap();
        let saved = get_config(&c, id).unwrap().unwrap();
        assert_eq!(saved.imap_security, ImapSecurity::Starttls);
        assert_eq!(saved.trusted_certificate.as_deref(), Some(certificate));
        let existing = get_config(&c, 1).unwrap().unwrap();
        assert_eq!(existing.imap_security, ImapSecurity::Tls);
        assert!(existing.trusted_certificate.is_none());
    }

    #[test]
    fn set_display_name_sets_and_clears() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        set_display_name(&c, 1, Some("Ann Lee - Acme Customer Support Team")).unwrap();
        assert_eq!(
            get(&c, 1).unwrap().unwrap().display_name.as_deref(),
            Some("Ann Lee - Acme Customer Support Team")
        );
        set_display_name(&c, 1, None).unwrap();
        assert_eq!(get(&c, 1).unwrap().unwrap().display_name, None);
    }
}
