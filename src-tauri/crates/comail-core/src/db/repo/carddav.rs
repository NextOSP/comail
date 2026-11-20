//! CardDAV server config (one row per account), discovered address books and
//! the cards they hold, plus the bridge into `contacts`. Credentials never
//! live here: the app password goes to the keyring.
//!
//! Every write that adds, changes or drops card emails returns the affected
//! addresses; callers pass them to [`reconcile_emails`] in the same
//! transaction so `contacts.book_name`/`book_folded` and the per-account
//! `contact_accounts` scope always match the enabled address books.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::carddav::vcard::Card;
use crate::error::Result;
use crate::models::{AddressBook, CardEmail, CardPhone, ContactCard, ContactServer};
use crate::search::fold;

#[derive(Debug, Clone)]
pub struct CarddavConfig {
    pub account_id: i64,
    pub base_url: String,
    pub username: Option<String>,
    pub principal_url: Option<String>,
    pub home_set_url: Option<String>,
    pub enabled: bool,
    pub last_error: Option<String>,
    pub last_synced_at: Option<i64>,
}

fn config_row(row: &Row) -> rusqlite::Result<CarddavConfig> {
    Ok(CarddavConfig {
        account_id: row.get("account_id")?,
        base_url: row.get("base_url")?,
        username: row.get("username")?,
        principal_url: row.get("principal_url")?,
        home_set_url: row.get("home_set_url")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        last_error: row.get("last_error")?,
        last_synced_at: row.get("last_synced_at")?,
    })
}

const BOOK_SELECT: &str = "
    SELECT b.id, b.account_id, b.url, b.display_name, b.enabled, b.last_synced_at,
           (SELECT COUNT(*) FROM contact_cards cc
             WHERE cc.address_book_id = b.id
               AND EXISTS (SELECT 1 FROM contact_card_emails e WHERE e.card_id = cc.id)
           ) AS card_count
    FROM address_books b";

fn book_row(row: &Row) -> rusqlite::Result<AddressBook> {
    Ok(AddressBook {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        url: row.get("url")?,
        display_name: row.get("display_name")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        card_count: row.get("card_count")?,
        last_synced_at: row.get("last_synced_at")?,
    })
}

/// Which card speaks for an address found on several: an entry marked
/// preferred, then a card that has a name, then the oldest.
const BEST_CARD_ORDER: &str = "e.pref DESC, (cc.full_name IS NULL) ASC, cc.id ASC";

// ---------- config ----------

pub fn upsert_config(conn: &Connection, cfg: &CarddavConfig) -> Result<()> {
    conn.execute(
        "INSERT INTO carddav_config
            (account_id, base_url, username, principal_url, home_set_url, enabled, last_error)
         VALUES (?1,?2,?3,?4,?5,?6,NULL)
         ON CONFLICT(account_id) DO UPDATE SET
            base_url = excluded.base_url, username = excluded.username,
            principal_url = excluded.principal_url, home_set_url = excluded.home_set_url,
            enabled = excluded.enabled, last_error = NULL",
        params![
            cfg.account_id,
            cfg.base_url,
            cfg.username,
            cfg.principal_url,
            cfg.home_set_url,
            cfg.enabled as i64,
        ],
    )?;
    Ok(())
}

pub fn get_config(conn: &Connection, account_id: i64) -> Result<Option<CarddavConfig>> {
    conn.query_row(
        "SELECT * FROM carddav_config WHERE account_id = ?1",
        params![account_id],
        config_row,
    )
    .optional()
    .map_err(Into::into)
}

pub fn all_configs(conn: &Connection) -> Result<Vec<CarddavConfig>> {
    let mut stmt = conn.prepare("SELECT * FROM carddav_config WHERE enabled = 1")?;
    let rows = stmt
        .query_map([], config_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Record a finished sync cycle: its error (None = success) and, on
/// success, when it ended.
pub fn set_status(
    conn: &Connection,
    account_id: i64,
    error: Option<&str>,
    synced_at: Option<i64>,
) -> Result<()> {
    conn.execute(
        "UPDATE carddav_config
            SET last_error = ?2, last_synced_at = COALESCE(?3, last_synced_at)
          WHERE account_id = ?1",
        params![account_id, error, synced_at],
    )?;
    Ok(())
}

/// Every connected account with its address books, for settings.
pub fn list_servers(conn: &Connection) -> Result<Vec<ContactServer>> {
    let mut stmt = conn.prepare("SELECT * FROM carddav_config ORDER BY account_id")?;
    let configs = stmt
        .query_map([], config_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(configs.len());
    for cfg in configs {
        out.push(ContactServer {
            account_id: cfg.account_id,
            base_url: cfg.base_url,
            username: cfg.username,
            last_error: cfg.last_error,
            last_synced_at: cfg.last_synced_at,
            address_books: list_address_books(conn, Some(cfg.account_id))?,
        });
    }
    Ok(out)
}

/// Drop the account's CardDAV connection and everything it synced. Contacts
/// that mail also taught us keep their harvested name and counts.
pub fn delete_config(conn: &Connection, account_id: i64) -> Result<()> {
    let emails = emails_where(conn, "b.account_id = ?1", account_id)?;
    conn.execute(
        "DELETE FROM address_books WHERE account_id = ?1",
        params![account_id],
    )?;
    conn.execute(
        "DELETE FROM carddav_config WHERE account_id = ?1",
        params![account_id],
    )?;
    reconcile_emails(conn, &emails)
}

// ---------- address books ----------

/// Upsert a discovered address book; returns its id. Sync state and the
/// enabled choice survive re-discovery.
pub fn upsert_address_book(
    conn: &Connection,
    account_id: i64,
    url: &str,
    display_name: Option<&str>,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO address_books (account_id, url, display_name) VALUES (?1,?2,?3)
         ON CONFLICT(account_id, url) DO UPDATE SET display_name = excluded.display_name",
        params![account_id, url, display_name],
    )?;
    conn.query_row(
        "SELECT id FROM address_books WHERE account_id = ?1 AND url = ?2",
        params![account_id, url],
        |r| r.get(0),
    )
    .map_err(Into::into)
}

/// Forget the account's address books that discovery no longer lists (a
/// reconnect to another server or URL), unwinding their contacts.
pub fn prune_address_books(conn: &Connection, account_id: i64, keep_urls: &[String]) -> Result<()> {
    let stale: Vec<i64> = list_address_books(conn, Some(account_id))?
        .into_iter()
        .filter(|b| !keep_urls.contains(&b.url))
        .map(|b| b.id)
        .collect();
    for id in stale {
        let emails = emails_where(conn, "b.id = ?1", id)?;
        conn.execute("DELETE FROM address_books WHERE id = ?1", params![id])?;
        reconcile_emails(conn, &emails)?;
    }
    Ok(())
}

/// False for a book that was switched off or deleted while a pull was in
/// flight; the pull then drops what it fetched instead of resurrecting it.
pub fn is_book_enabled(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT enabled FROM address_books WHERE id = ?1",
            params![id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_some_and(|e| e != 0))
}

pub fn list_address_books(conn: &Connection, account_id: Option<i64>) -> Result<Vec<AddressBook>> {
    let rows = match account_id {
        Some(id) => {
            let mut stmt = conn.prepare(&format!(
                "{BOOK_SELECT} WHERE b.account_id = ?1 ORDER BY b.id"
            ))?;
            stmt.query_map(params![id], book_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        }
        None => {
            let mut stmt = conn.prepare(&format!("{BOOK_SELECT} ORDER BY b.account_id, b.id"))?;
            stmt.query_map([], book_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        }
    };
    Ok(rows)
}

pub fn get_address_book(conn: &Connection, id: i64) -> Result<Option<AddressBook>> {
    conn.query_row(
        &format!("{BOOK_SELECT} WHERE b.id = ?1"),
        params![id],
        book_row,
    )
    .optional()
    .map_err(Into::into)
}

/// Include or exclude an address book. Excluding drops its cards (and with
/// them the names they supplied) and forgets its sync state, so including it
/// again pulls it fresh.
pub fn set_address_book_enabled(conn: &Connection, id: i64, enabled: bool) -> Result<()> {
    if enabled {
        conn.execute(
            "UPDATE address_books SET enabled = 1 WHERE id = ?1",
            params![id],
        )?;
        return Ok(());
    }
    let emails = emails_where(conn, "b.id = ?1", id)?;
    conn.execute(
        "DELETE FROM contact_cards WHERE address_book_id = ?1",
        params![id],
    )?;
    conn.execute(
        "UPDATE address_books SET enabled = 0, ctag = NULL, sync_token = NULL WHERE id = ?1",
        params![id],
    )?;
    reconcile_emails(conn, &emails)
}

/// (ctag, sync_token) as last stored.
pub fn book_sync_state(conn: &Connection, id: i64) -> Result<(Option<String>, Option<String>)> {
    conn.query_row(
        "SELECT ctag, sync_token FROM address_books WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(Into::into)
}

pub fn set_book_sync_state(
    conn: &Connection,
    id: i64,
    ctag: Option<&str>,
    sync_token: Option<&str>,
    synced_at: i64,
) -> Result<()> {
    // A book switched off mid-pull keeps its reset state, so switching it
    // back on pulls it in full.
    conn.execute(
        "UPDATE address_books SET ctag = ?2, sync_token = ?3, last_synced_at = ?4
          WHERE id = ?1 AND enabled = 1",
        params![id, ctag, sync_token, synced_at],
    )?;
    Ok(())
}

// ---------- cards ----------

/// href -> etag of every stored card in the address book.
pub fn card_etags(conn: &Connection, book_id: i64) -> Result<HashMap<String, Option<String>>> {
    let mut stmt =
        conn.prepare("SELECT href, etag FROM contact_cards WHERE address_book_id = ?1")?;
    let rows = stmt
        .query_map(params![book_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<HashMap<_, _>>>()?;
    Ok(rows)
}

/// Store a fetched card (None = unparseable; kept with its etag so it isn't
/// fetched again every cycle). Returns the emails it had and has now.
pub fn upsert_card(
    conn: &Connection,
    book_id: i64,
    href: &str,
    etag: Option<&str>,
    card: Option<&Card>,
) -> Result<Vec<String>> {
    let mut affected = emails_of_href(conn, book_id, href)?;
    let phones = card.map(|c| c.phones.as_slice()).unwrap_or_default();
    conn.execute(
        "INSERT INTO contact_cards
            (address_book_id, href, etag, uid, full_name, nickname, org, title, phones_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(address_book_id, href) DO UPDATE SET
            etag = excluded.etag, uid = excluded.uid, full_name = excluded.full_name,
            nickname = excluded.nickname, org = excluded.org, title = excluded.title,
            phones_json = excluded.phones_json",
        params![
            book_id,
            href,
            etag,
            card.and_then(|c| c.uid.clone()),
            card.and_then(Card::display_name),
            card.and_then(|c| c.nickname.clone()),
            card.and_then(|c| c.org.clone()),
            card.and_then(|c| c.title.clone()),
            serde_json::to_string(phones)?,
        ],
    )?;
    let card_id: i64 = conn.query_row(
        "SELECT id FROM contact_cards WHERE address_book_id = ?1 AND href = ?2",
        params![book_id, href],
        |r| r.get(0),
    )?;
    conn.execute(
        "DELETE FROM contact_card_emails WHERE card_id = ?1",
        params![card_id],
    )?;
    // Contact groups list members, not addresses of their own.
    if let Some(card) = card.filter(|c| !c.is_group) {
        let mut stmt = conn.prepare_cached(
            "INSERT OR IGNORE INTO contact_card_emails (card_id, email, kind, pref, position)
             VALUES (?1,?2,?3,?4,?5)",
        )?;
        for (pos, e) in card.emails.iter().enumerate() {
            stmt.execute(params![card_id, e.email, e.kind, e.pref as i64, pos as i64])?;
            affected.push(e.email.clone());
        }
    }
    Ok(affected)
}

/// Forget a card the server deleted. Returns the emails it had.
pub fn delete_card(conn: &Connection, book_id: i64, href: &str) -> Result<Vec<String>> {
    let emails = emails_of_href(conn, book_id, href)?;
    conn.execute(
        "DELETE FROM contact_cards WHERE address_book_id = ?1 AND href = ?2",
        params![book_id, href],
    )?;
    Ok(emails)
}

fn emails_of_href(conn: &Connection, book_id: i64, href: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT e.email FROM contact_card_emails e
           JOIN contact_cards cc ON cc.id = e.card_id
         WHERE cc.address_book_id = ?1 AND cc.href = ?2",
    )?;
    let rows = stmt
        .query_map(params![book_id, href], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(rows)
}

/// Emails of every card in the address books matching `filter` (over `b`).
fn emails_where(conn: &Connection, filter: &str, id: i64) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT DISTINCT e.email FROM contact_card_emails e
           JOIN contact_cards cc ON cc.id = e.card_id
           JOIN address_books b ON b.id = cc.address_book_id
         WHERE {filter}"
    ))?;
    let rows = stmt
        .query_map(params![id], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(rows)
}

// ---------- the bridge into `contacts` ----------

/// Bring `contacts` in line with the enabled address books for these
/// addresses. An address on a card gets the card's name as `book_name` (a
/// row is created when mail never showed it to us) and a scope row for each
/// account whose address books hold it. An address on no card loses its
/// book name; a row that only existed because of a card is deleted, while
/// harvested ones keep their own name and counts.
pub fn reconcile_emails(conn: &Connection, emails: &[String]) -> Result<()> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut best_stmt = conn.prepare_cached(&format!(
        "SELECT cc.full_name, cc.nickname FROM contact_card_emails e
           JOIN contact_cards cc ON cc.id = e.card_id
           JOIN address_books b ON b.id = cc.address_book_id
         WHERE e.email = ?1 AND b.enabled = 1
         ORDER BY {BEST_CARD_ORDER} LIMIT 1"
    ))?;
    for email in emails {
        let email = email.trim().to_lowercase();
        if email.is_empty() || !seen.insert(email.clone()) {
            continue;
        }
        let best: Option<(Option<String>, Option<String>)> = best_stmt
            .query_row(params![email], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        match best {
            Some((name, nickname)) => {
                let name = name.unwrap_or_default();
                let book_folded = fold(&format!("{name} {}", nickname.unwrap_or_default()));
                conn.execute(
                    "INSERT INTO contacts
                        (email, name, folded, send_count, recv_count, last_interacted,
                         book_name, book_folded)
                     VALUES (?1, NULL, ?2, 0, 0, NULL, ?3, ?4)
                     ON CONFLICT(email) DO UPDATE SET
                        book_name = excluded.book_name, book_folded = excluded.book_folded",
                    params![email, fold(&format!(" {email}")), name, book_folded.trim()],
                )?;
                conn.execute(
                    "INSERT OR IGNORE INTO contact_accounts
                        (contact_id, account_id, send_count, recv_count, last_interacted)
                     SELECT DISTINCT c.id, b.account_id, 0, 0, NULL
                     FROM contact_card_emails e
                       JOIN contact_cards cc ON cc.id = e.card_id
                       JOIN address_books b ON b.id = cc.address_book_id
                       JOIN contacts c ON c.email = e.email
                     WHERE e.email = ?1 AND b.enabled = 1",
                    params![email],
                )?;
                // Scope rows only an address book put there (no mail either
                // way) go when no address book of that account holds it now.
                conn.execute(
                    "DELETE FROM contact_accounts
                     WHERE contact_id = (SELECT id FROM contacts WHERE email = ?1)
                       AND send_count = 0 AND recv_count = 0
                       AND account_id NOT IN (
                         SELECT b.account_id FROM contact_card_emails e
                           JOIN contact_cards cc ON cc.id = e.card_id
                           JOIN address_books b ON b.id = cc.address_book_id
                         WHERE e.email = ?1 AND b.enabled = 1)",
                    params![email],
                )?;
            }
            None => {
                // Harvest always counts a send or a receive, so zero counts
                // mean the row came from an address book alone.
                conn.execute(
                    "DELETE FROM contacts WHERE email = ?1 AND send_count = 0 AND recv_count = 0",
                    params![email],
                )?;
                conn.execute(
                    "UPDATE contacts SET book_name = NULL, book_folded = NULL WHERE email = ?1",
                    params![email],
                )?;
                conn.execute(
                    "DELETE FROM contact_accounts
                     WHERE contact_id = (SELECT id FROM contacts WHERE email = ?1)
                       AND send_count = 0 AND recv_count = 0",
                    params![email],
                )?;
            }
        }
    }
    Ok(())
}

/// The address-book card for `email`, for the contact pane.
pub fn card_for_email(conn: &Connection, email: &str) -> Result<Option<ContactCard>> {
    let email = email.trim().to_lowercase();
    let row = conn
        .query_row(
            &format!(
                "SELECT cc.id, cc.full_name, cc.nickname, cc.org, cc.title, cc.phones_json,
                        b.display_name
                 FROM contact_card_emails e
                   JOIN contact_cards cc ON cc.id = e.card_id
                   JOIN address_books b ON b.id = cc.address_book_id
                 WHERE e.email = ?1 AND b.enabled = 1
                 ORDER BY {BEST_CARD_ORDER} LIMIT 1"
            ),
            params![email],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    ContactCard {
                        name: r.get(1)?,
                        nickname: r.get(2)?,
                        org: r.get(3)?,
                        title: r.get(4)?,
                        emails: Vec::new(),
                        phones: serde_json::from_str::<Vec<CardPhone>>(&r.get::<_, String>(5)?)
                            .unwrap_or_default(),
                        address_book: r.get(6)?,
                    },
                ))
            },
        )
        .optional()?;
    let Some((card_id, mut card)) = row else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(
        "SELECT email, kind FROM contact_card_emails WHERE card_id = ?1 ORDER BY position",
    )?;
    card.emails = stmt
        .query_map(params![card_id], |r| {
            Ok(CardEmail {
                email: r.get(0)?,
                kind: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(card))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::carddav::vcard;
    use crate::db::repo::contacts;
    use crate::db::testutil;
    use crate::models::Address;

    fn seed(c: &Connection) -> i64 {
        testutil::seed_account(c);
        upsert_config(
            c,
            &CarddavConfig {
                account_id: 1,
                base_url: "https://dav.example.com/".into(),
                username: Some("me".into()),
                principal_url: None,
                home_set_url: None,
                enabled: true,
                last_error: None,
                last_synced_at: None,
            },
        )
        .unwrap();
        upsert_address_book(c, 1, "https://dav.example.com/ab/", Some("Contacts")).unwrap()
    }

    fn put(c: &Connection, book: i64, href: &str, vcf: &str) {
        let card = vcard::parse(vcf);
        let emails = upsert_card(c, book, href, Some("\"e\""), card.as_ref()).unwrap();
        reconcile_emails(c, &emails).unwrap();
    }

    fn remove(c: &Connection, book: i64, href: &str) {
        let emails = delete_card(c, book, href).unwrap();
        reconcile_emails(c, &emails).unwrap();
    }

    fn row(c: &Connection, email: &str) -> Option<(Option<String>, Option<String>, i64)> {
        c.query_row(
            "SELECT name, book_name, send_count FROM contacts WHERE email = ?1",
            params![email],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .unwrap()
    }

    fn addr(email: &str, name: Option<&str>) -> Address {
        Address {
            name: name.map(str::to_string),
            email: email.into(),
        }
    }

    #[test]
    fn card_names_win_and_server_deletes_keep_harvested_data() {
        let c = testutil::conn();
        let book = seed(&c);
        // Mail taught us Bao under a header name, and we wrote to him.
        contacts::harvest(&c, 1, &addr("bao@acme.com", Some("bao (Acme)")), true, 100).unwrap();

        put(
            &c,
            book,
            "/ab/bao.vcf",
            "BEGIN:VCARD\nVERSION:3.0\nFN:Bảo Lưu\nEMAIL:Bao@Acme.com\nEMAIL:bao@home.example\nEND:VCARD",
        );
        // The card's name wins for display; harvested data stays as it was.
        assert_eq!(
            row(&c, "bao@acme.com"),
            Some((Some("bao (Acme)".into()), Some("Bảo Lưu".into()), 1))
        );
        // An address mail never showed us becomes a contact of its own.
        assert_eq!(
            row(&c, "bao@home.example"),
            Some((None, Some("Bảo Lưu".into()), 0))
        );
        let hits = contacts::autocomplete(&c, "luu", Some(1), 10).unwrap();
        assert_eq!(
            hits.iter()
                .map(|h| (h.email.as_str(), h.name.as_deref()))
                .collect::<Vec<_>>(),
            [
                ("bao@acme.com", Some("Bảo Lưu")),
                ("bao@home.example", Some("Bảo Lưu"))
            ]
        );

        // Server deletes the card: the card-only address disappears, the
        // harvested one falls back to the name mail taught us.
        remove(&c, book, "/ab/bao.vcf");
        assert_eq!(row(&c, "bao@home.example"), None);
        assert_eq!(
            row(&c, "bao@acme.com"),
            Some((Some("bao (Acme)".into()), None, 1))
        );
        let hits = contacts::autocomplete(&c, "bao", Some(1), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name.as_deref(), Some("bao (Acme)"));
        let scoped: i64 = c
            .query_row("SELECT COUNT(*) FROM contact_accounts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(scoped, 1, "only the harvested scope row is left");
    }

    #[test]
    fn edited_card_moves_names_between_addresses() {
        let c = testutil::conn();
        let book = seed(&c);
        put(
            &c,
            book,
            "/ab/a.vcf",
            "BEGIN:VCARD\nFN:Ann\nEMAIL:ann@old.example\nEND:VCARD",
        );
        put(
            &c,
            book,
            "/ab/a.vcf",
            "BEGIN:VCARD\nFN:Ann Smith\nEMAIL:ann@new.example\nEND:VCARD",
        );
        assert_eq!(row(&c, "ann@old.example"), None);
        assert_eq!(
            row(&c, "ann@new.example").unwrap().1.as_deref(),
            Some("Ann Smith")
        );
    }

    #[test]
    fn preferred_entry_names_a_shared_address() {
        let c = testutil::conn();
        let book = seed(&c);
        put(
            &c,
            book,
            "/ab/team.vcf",
            "BEGIN:VCARD\nFN:Support team\nEMAIL:help@acme.com\nEND:VCARD",
        );
        put(
            &c,
            book,
            "/ab/kim.vcf",
            "BEGIN:VCARD\nFN:Kim\nEMAIL;TYPE=pref:help@acme.com\nTEL;TYPE=cell:+1 555\nEND:VCARD",
        );
        assert_eq!(row(&c, "help@acme.com").unwrap().1.as_deref(), Some("Kim"));
        let card = card_for_email(&c, "HELP@acme.com").unwrap().unwrap();
        assert_eq!(card.name.as_deref(), Some("Kim"));
        assert_eq!(card.address_book.as_deref(), Some("Contacts"));
        assert_eq!(card.phones[0].number, "+1 555");
        assert_eq!(card.emails[0].email, "help@acme.com");
        // Kim's card goes; the other card still names the address.
        remove(&c, book, "/ab/kim.vcf");
        assert_eq!(
            row(&c, "help@acme.com").unwrap().1.as_deref(),
            Some("Support team")
        );
    }

    #[test]
    fn disabling_a_book_or_disconnecting_unwinds_its_contacts() {
        let c = testutil::conn();
        let book = seed(&c);
        put(
            &c,
            book,
            "/ab/a.vcf",
            "BEGIN:VCARD\nFN:Ann\nEMAIL:ann@example.com\nEND:VCARD",
        );
        set_book_sync_state(&c, book, Some("c1"), Some("t1"), 5).unwrap();
        assert_eq!(list_address_books(&c, Some(1)).unwrap()[0].card_count, 1);

        set_address_book_enabled(&c, book, false).unwrap();
        assert_eq!(row(&c, "ann@example.com"), None);
        assert_eq!(book_sync_state(&c, book).unwrap(), (None, None));
        assert!(card_etags(&c, book).unwrap().is_empty());

        set_address_book_enabled(&c, book, true).unwrap();
        put(
            &c,
            book,
            "/ab/a.vcf",
            "BEGIN:VCARD\nFN:Ann\nEMAIL:ann@example.com\nEND:VCARD",
        );
        assert!(row(&c, "ann@example.com").is_some());
        // Re-discovery keeps the book (and its enabled choice).
        let again =
            upsert_address_book(&c, 1, "https://dav.example.com/ab/", Some("Renamed")).unwrap();
        assert_eq!(again, book);

        delete_config(&c, 1).unwrap();
        assert_eq!(row(&c, "ann@example.com"), None);
        assert!(list_servers(&c).unwrap().is_empty());
    }

    #[test]
    fn groups_and_unparseable_cards_contribute_no_addresses() {
        let c = testutil::conn();
        let book = seed(&c);
        put(
            &c,
            book,
            "/ab/g.vcf",
            "BEGIN:VCARD\nVERSION:4.0\nKIND:group\nFN:Club\nEMAIL:club@example.com\nEND:VCARD",
        );
        put(&c, book, "/ab/junk.vcf", "garbage");
        assert_eq!(row(&c, "club@example.com"), None);
        // Both are remembered by etag so they aren't fetched again.
        assert_eq!(card_etags(&c, book).unwrap().len(), 2);
        assert_eq!(list_address_books(&c, Some(1)).unwrap()[0].card_count, 0);
    }

    #[test]
    fn senders_show_under_their_address_book_name() {
        use crate::db::repo::{messages, threads};
        let c = testutil::conn();
        let book = seed(&c);
        let (thread_id, _) = testutil::seed_message(&c, "Bao@Acme.com", "Hello", false);
        c.execute(
            "UPDATE messages SET from_name = 'bao.luu' WHERE thread_id = ?1",
            params![thread_id],
        )
        .unwrap();
        threads::recompute(&c, thread_id).unwrap();
        let sender = |c: &Connection| {
            let t = threads::get_summary(c, thread_id).unwrap().unwrap();
            let m = messages::list_for_thread(c, thread_id).unwrap();
            (t.participants[0].name.clone(), m[0].from.name.clone())
        };
        assert_eq!(sender(&c), (Some("bao.luu".into()), Some("bao.luu".into())));

        put(
            &c,
            book,
            "/ab/bao.vcf",
            "BEGIN:VCARD\nFN:Bảo Lưu\nEMAIL:bao@acme.com\nEND:VCARD",
        );
        assert_eq!(sender(&c), (Some("Bảo Lưu".into()), Some("Bảo Lưu".into())));
        let page = threads::get_summaries(&c, &[thread_id]).unwrap();
        assert_eq!(page[0].participants[0].name.as_deref(), Some("Bảo Lưu"));

        // A card without a name never blanks out the header name.
        put(
            &c,
            book,
            "/ab/bao.vcf",
            "BEGIN:VCARD\nEMAIL:bao@acme.com\nEND:VCARD",
        );
        assert_eq!(sender(&c), (Some("bao.luu".into()), Some("bao.luu".into())));
    }

    #[test]
    fn status_keeps_last_success_time_through_errors() {
        let c = testutil::conn();
        seed(&c);
        set_status(&c, 1, None, Some(100)).unwrap();
        set_status(&c, 1, Some("boom"), None).unwrap();
        let s = &list_servers(&c).unwrap()[0];
        assert_eq!(s.last_error.as_deref(), Some("boom"));
        assert_eq!(s.last_synced_at, Some(100));
        assert_eq!(s.address_books.len(), 1);
    }
}
