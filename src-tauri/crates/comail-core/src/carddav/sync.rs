//! Per-address-book pull. For each enabled book: a ctag / sync-token gate,
//! then the changed hrefs from an incremental sync-collection REPORT when we
//! hold a token, else from a full PROPFIND etag listing diffed against what
//! we stored; changed cards come in through addressbook-multiget. Every
//! batch reconciles the touched addresses into `contacts` in the same
//! transaction. Read-only: nothing is sent back.

use std::collections::HashMap;

use crate::caldav::sync::href_path;
use crate::caldav::{Transport, xml};
use crate::db::Db;
use crate::db::repo;
use crate::error::{CoreError, Result};
use crate::models::now_ms;

use super::{as_carddav, err, vcard};

/// Cards per addressbook-multiget. Smaller than CalDAV's batch: cards can
/// carry inline photos.
const MULTIGET_BATCH: usize = 25;

/// What one account's pull did.
#[derive(Debug, Default)]
pub struct SyncOutcome {
    /// Any card was added, changed or removed.
    pub changed: bool,
    /// Address books that failed, as "name: error" (the others still synced).
    pub errors: Vec<String>,
}

/// What to do to the local copy of one address book.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Delta {
    /// Hrefs to fetch, with the etag the listing reported.
    pub fetch: Vec<(String, Option<String>)>,
    /// Hrefs to forget.
    pub removed: Vec<String>,
}

/// A resource needs fetching when we don't have it, the server gave no etag
/// to compare, or the etag changed.
fn needs_fetch(local: &HashMap<String, Option<String>>, href: &str, etag: &Option<String>) -> bool {
    match local.get(href) {
        Some(stored) => etag.is_none() || stored != etag,
        None => true,
    }
}

/// A full listing against the stored cards: new or changed resources are
/// fetched, stored ones the server no longer lists are removed.
pub(crate) fn diff_full(
    local: &HashMap<String, Option<String>>,
    server: &[(String, Option<String>)],
) -> Delta {
    let listed: std::collections::HashSet<&str> = server.iter().map(|(h, _)| h.as_str()).collect();
    let mut removed: Vec<String> = local
        .keys()
        .filter(|h| !listed.contains(h.as_str()))
        .cloned()
        .collect();
    removed.sort();
    Delta {
        fetch: server
            .iter()
            .filter(|(h, e)| needs_fetch(local, h, e))
            .cloned()
            .collect(),
        removed,
    }
}

/// A sync-collection report against the stored cards: reported members are
/// fetched unless their etag is unchanged; 404 members are removed.
pub(crate) fn diff_incremental(
    local: &HashMap<String, Option<String>>,
    changed: &[(String, Option<String>)],
    gone: &[String],
) -> Delta {
    Delta {
        fetch: changed
            .iter()
            .filter(|(h, e)| needs_fetch(local, h, e))
            .cloned()
            .collect(),
        removed: gone.to_vec(),
    }
}

/// One account's pull across its enabled address books.
pub async fn sync_account(db: &Db, t: &dyn Transport, account_id: i64) -> Result<SyncOutcome> {
    let books = db
        .read(move |conn| repo::carddav::list_address_books(conn, Some(account_id)))
        .await?;
    let mut outcome = SyncOutcome::default();
    for book in books.into_iter().filter(|b| b.enabled) {
        match sync_book(db, t, book.id, &book.url)
            .await
            .map_err(as_carddav)
        {
            Ok(changed) => outcome.changed |= changed,
            Err(CoreError::NeedsReauth) => return Err(CoreError::NeedsReauth),
            // Offline is the whole account's state, not one book's.
            Err(CoreError::Offline) => return Err(CoreError::Offline),
            Err(e) => {
                tracing::warn!("address book {} sync failed: {e}", book.id);
                let name = book.display_name.unwrap_or(book.url);
                outcome.errors.push(format!("{name}: {e}"));
            }
        }
    }
    Ok(outcome)
}

/// Pull one address book; true when any card changed.
async fn sync_book(db: &Db, t: &dyn Transport, book_id: i64, book_url: &str) -> Result<bool> {
    let (stored_ctag, stored_token) = db
        .read(move |conn| repo::carddav::book_sync_state(conn, book_id))
        .await?;

    // Cheap gate: an unchanged ctag (or, without one, an unchanged sync
    // token) means nothing to do.
    let resp = t
        .request(
            "PROPFIND",
            book_url,
            Some("0"),
            &[],
            Some(xml::propfind_ctag()),
        )
        .await?;
    let (ctag, current_token) = if resp.status == 207 {
        let ms = xml::parse_multistatus(&resp.body)?;
        let item = ms.items.first();
        (
            item.and_then(|i| i.ctag.clone()),
            item.and_then(|i| i.sync_token.clone()),
        )
    } else {
        (None, None)
    };
    let unchanged = match (&ctag, &current_token) {
        (Some(c), _) => Some(c) == stored_ctag.as_ref(),
        (None, Some(tok)) => Some(tok) == stored_token.as_ref(),
        (None, None) => false,
    };
    if unchanged {
        return Ok(false);
    }

    let book_path = href_path(book_url);
    let local = db
        .read(move |conn| repo::carddav::card_etags(conn, book_id))
        .await?;
    let mut delta: Option<Delta> = None;
    let mut new_token: Option<String> = None;

    if let Some(token) = &stored_token {
        let resp = t
            .request(
                "REPORT",
                book_url,
                Some("1"),
                &[],
                Some(xml::report_sync_collection(token)),
            )
            .await?;
        // 403/409 with valid-sync-token (expired token) or no support at all:
        // fall through to the full listing.
        if resp.status == 207 && !resp.body.contains("valid-sync-token") {
            let ms = xml::parse_multistatus(&resp.body)?;
            let mut changed = Vec::new();
            let mut gone = Vec::new();
            for item in &ms.items {
                let path = href_path(&item.href);
                if path.is_empty() || path == book_path || item.is_collection {
                    continue;
                }
                if item.status == 404 {
                    gone.push(path);
                } else if (200..300).contains(&item.status) {
                    changed.push((path, item.etag.clone()));
                }
            }
            delta = Some(diff_incremental(&local, &changed, &gone));
            new_token = ms.sync_token.or_else(|| current_token.clone());
        }
    }

    let delta = match delta {
        Some(d) => d,
        None => {
            let resp = t
                .request(
                    "PROPFIND",
                    book_url,
                    Some("1"),
                    &[],
                    Some(xml::propfind_etags()),
                )
                .await?;
            if resp.status != 207 {
                return Err(err(format!("listing {book_url}: HTTP {}", resp.status)));
            }
            let ms = xml::parse_multistatus(&resp.body)?;
            let server: Vec<(String, Option<String>)> = ms
                .items
                .iter()
                .filter(|i| i.status == 200 && !i.href.is_empty() && !i.is_collection)
                .map(|i| (href_path(&i.href), i.etag.clone()))
                .filter(|(path, _)| *path != book_path)
                .collect();
            // The token from the gate predates this listing, so the next
            // incremental pull can only re-report (never miss) a change.
            new_token = current_token.clone();
            diff_full(&local, &server)
        }
    };

    let mut changed_any = false;
    let mut removed = delta.removed;
    for batch in delta.fetch.chunks(MULTIGET_BATCH) {
        let hrefs: Vec<String> = batch.iter().map(|(h, _)| h.clone()).collect();
        let listed_etags: HashMap<String, Option<String>> = batch.iter().cloned().collect();
        let resp = t
            .request(
                "REPORT",
                book_url,
                Some("1"),
                &[],
                Some(xml::report_addressbook_multiget(&hrefs)),
            )
            .await?;
        if resp.status != 207 {
            return Err(err(format!("addressbook-multiget: HTTP {}", resp.status)));
        }
        let ms = xml::parse_multistatus(&resp.body)?;
        let mut cards: Vec<(String, Option<String>, Option<vcard::Card>)> = Vec::new();
        for item in &ms.items {
            let path = href_path(&item.href);
            if item.status == 404 {
                removed.push(path); // deleted between listing and fetch
                continue;
            }
            if item.status != 200 {
                continue;
            }
            let Some(data) = item.address_data.as_deref() else {
                continue;
            };
            let etag = item
                .etag
                .clone()
                .or_else(|| listed_etags.get(&path).cloned().flatten());
            cards.push((path, etag, vcard::parse(data)));
        }
        if cards.is_empty() {
            continue;
        }
        changed_any = true;
        db.write(move |conn| {
            let tx = conn.transaction()?;
            if !repo::carddav::is_book_enabled(&tx, book_id)? {
                return Ok(()); // switched off or disconnected meanwhile
            }
            let mut touched = Vec::new();
            for (href, etag, card) in &cards {
                touched.extend(repo::carddav::upsert_card(
                    &tx,
                    book_id,
                    href,
                    etag.as_deref(),
                    card.as_ref(),
                )?);
            }
            repo::carddav::reconcile_emails(&tx, &touched)?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    }

    removed.retain(|h| local.contains_key(h));
    if !removed.is_empty() {
        changed_any = true;
        db.write(move |conn| {
            let tx = conn.transaction()?;
            if !repo::carddav::is_book_enabled(&tx, book_id)? {
                return Ok(());
            }
            let mut touched = Vec::new();
            for href in &removed {
                touched.extend(repo::carddav::delete_card(&tx, book_id, href)?);
            }
            repo::carddav::reconcile_emails(&tx, &touched)?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    }

    let synced_at = now_ms();
    db.write(move |conn| {
        repo::carddav::set_book_sync_state(
            conn,
            book_id,
            ctag.as_deref(),
            new_token.as_deref(),
            synced_at,
        )
    })
    .await?;
    Ok(changed_any)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caldav::http::{DavResponse, MockTransport};

    fn etags(pairs: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
        pairs
            .iter()
            .map(|(h, e)| (h.to_string(), e.map(str::to_string)))
            .collect()
    }

    fn local(pairs: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
        etags(pairs).into_iter().collect()
    }

    #[test]
    fn full_listing_diff() {
        let stored = local(&[
            ("/ab/same.vcf", Some("1")),
            ("/ab/edited.vcf", Some("1")),
            ("/ab/deleted.vcf", Some("1")),
            ("/ab/no-etag.vcf", None),
        ]);
        let server = etags(&[
            ("/ab/same.vcf", Some("1")),
            ("/ab/edited.vcf", Some("2")),
            ("/ab/new.vcf", Some("1")),
            ("/ab/no-etag.vcf", None),
        ]);
        let d = diff_full(&stored, &server);
        assert_eq!(
            d.fetch,
            etags(&[
                ("/ab/edited.vcf", Some("2")),
                ("/ab/new.vcf", Some("1")),
                // No etag to compare: always refetched.
                ("/ab/no-etag.vcf", None),
            ])
        );
        assert_eq!(d.removed, ["/ab/deleted.vcf"]);
        // Nothing stored yet: everything is fetched, nothing removed.
        let first = diff_full(&HashMap::new(), &server);
        assert_eq!(first.fetch.len(), 4);
        assert!(first.removed.is_empty());
    }

    #[test]
    fn incremental_diff_skips_unchanged_etags() {
        let stored = local(&[("/ab/a.vcf", Some("1")), ("/ab/b.vcf", Some("1"))]);
        let d = diff_incremental(
            &stored,
            &etags(&[("/ab/a.vcf", Some("1")), ("/ab/b.vcf", Some("2"))]),
            &["/ab/c.vcf".to_string()],
        );
        assert_eq!(d.fetch, etags(&[("/ab/b.vcf", Some("2"))]));
        assert_eq!(d.removed, ["/ab/c.vcf"]);
    }

    // ---------- end-to-end against canned server responses ----------

    async fn seed_db() -> (Db, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("t.db")).unwrap();
        db.write(|c| {
            crate::db::testutil::seed_account(c);
            c.execute(
                "INSERT INTO carddav_config (account_id, base_url) VALUES (1,'https://dav.example.com/')",
                [],
            )?;
            c.execute(
                "INSERT INTO address_books (id, account_id, url, display_name)
                 VALUES (20, 1, 'https://dav.example.com/ab/me/contacts/', 'Contacts')",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        (db, dir)
    }

    fn ms207(body: &str) -> DavResponse {
        DavResponse {
            status: 207,
            etag: None,
            body: body.into(),
        }
    }

    fn gate(ctag: &str, token: &str) -> String {
        format!(
            r#"<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:response><d:href>/ab/me/contacts/</d:href><d:propstat><d:prop><cs:getctag>{ctag}</cs:getctag><d:sync-token>{token}</d:sync-token></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#
        )
    }

    /// Depth:1 listing: the collection itself, a sub-collection and two cards.
    const LISTING: &str = r#"<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
<d:response><d:href>/ab/me/contacts/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/ab/me/contacts/sub/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/ab/me/contacts/ann.vcf</d:href><d:propstat><d:prop><d:resourcetype/><d:getetag>"a1"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>https://dav.example.com/ab/me/contacts/bob.vcf</d:href><d:propstat><d:prop><d:resourcetype/><d:getetag>"b1"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"#;

    const MULTIGET: &str = r#"<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
<d:response><d:href>/ab/me/contacts/ann.vcf</d:href><d:propstat><d:prop><d:getetag>"a1"</d:getetag><card:address-data>BEGIN:VCARD
VERSION:3.0
FN:Ann Lee
EMAIL;TYPE=WORK:ann@example.com
END:VCARD</card:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/ab/me/contacts/bob.vcf</d:href><d:propstat><d:prop><d:getetag>"b1"</d:getetag><card:address-data>BEGIN:VCARD
VERSION:4.0
FN:Bob Stone
EMAIL:bob@example.com
END:VCARD</card:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"#;

    /// Incremental report: Bob edited, Ann deleted, new token.
    const SYNC_REPORT: &str = r#"<d:multistatus xmlns:d="DAV:">
<d:response><d:href>/ab/me/contacts/bob.vcf</d:href><d:propstat><d:prop><d:getetag>"b2"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/ab/me/contacts/ann.vcf</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>
<d:sync-token>tok-2</d:sync-token>
</d:multistatus>"#;

    const MULTIGET_BOB2: &str = r#"<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
<d:response><d:href>/ab/me/contacts/bob.vcf</d:href><d:propstat><d:prop><d:getetag>"b2"</d:getetag><card:address-data>BEGIN:VCARD
VERSION:4.0
FN:Robert Stone
EMAIL:bob@example.com
END:VCARD</card:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"#;

    async fn names(db: &Db) -> Vec<(String, Option<String>)> {
        db.read(|c| {
            let mut stmt = c.prepare("SELECT email, book_name FROM contacts ORDER BY email")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn full_pull_then_gate_then_incremental_changes() {
        let (db, _dir) = seed_db().await;

        // Cycle 1: no token yet -> gate, full listing, one multiget.
        let t = MockTransport::new(vec![
            ms207(&gate("c1", "tok-1")),
            ms207(LISTING),
            ms207(MULTIGET),
        ]);
        let out = sync_account(&db, &t, 1).await.unwrap();
        assert!(out.changed && out.errors.is_empty());
        {
            let seen = t.seen.lock().unwrap();
            let multiget = seen[2].2.as_deref().unwrap();
            assert!(multiget.contains("addressbook-multiget"));
            // Collection and sub-collection are never fetched as cards.
            assert!(!multiget.contains("/sub/"));
            assert!(multiget.contains("/ab/me/contacts/bob.vcf"));
        }
        assert_eq!(
            names(&db).await,
            [
                ("ann@example.com".to_string(), Some("Ann Lee".to_string())),
                ("bob@example.com".to_string(), Some("Bob Stone".to_string())),
            ]
        );
        let state = db
            .read(|c| repo::carddav::book_sync_state(c, 20))
            .await
            .unwrap();
        assert_eq!(state, (Some("c1".into()), Some("tok-1".into())));

        // Cycle 2: same ctag -> nothing else requested.
        let t = MockTransport::new(vec![ms207(&gate("c1", "tok-1"))]);
        let out = sync_account(&db, &t, 1).await.unwrap();
        assert!(!out.changed);
        assert_eq!(t.seen.lock().unwrap().len(), 1);

        // Cycle 3: new ctag -> sync-collection with the stored token.
        let t = MockTransport::new(vec![
            ms207(&gate("c2", "tok-2")),
            ms207(SYNC_REPORT),
            ms207(MULTIGET_BOB2),
        ]);
        let out = sync_account(&db, &t, 1).await.unwrap();
        assert!(out.changed);
        {
            let seen = t.seen.lock().unwrap();
            assert!(
                seen[1]
                    .2
                    .as_deref()
                    .unwrap()
                    .contains("<d:sync-token>tok-1</d:sync-token>")
            );
        }
        assert_eq!(
            names(&db).await,
            [(
                "bob@example.com".to_string(),
                Some("Robert Stone".to_string())
            )]
        );
        let state = db
            .read(|c| repo::carddav::book_sync_state(c, 20))
            .await
            .unwrap();
        assert_eq!(state, (Some("c2".into()), Some("tok-2".into())));
    }

    #[tokio::test]
    async fn expired_token_falls_back_to_listing_and_diffs() {
        let (db, _dir) = seed_db().await;
        // Stored: Ann (unchanged on the server) and Zed (deleted meanwhile).
        db.write(|c| {
            for (href, vcf) in [
                (
                    "/ab/me/contacts/ann.vcf",
                    "BEGIN:VCARD\nFN:Ann Lee\nEMAIL:ann@example.com\nEND:VCARD",
                ),
                (
                    "/ab/me/contacts/zed.vcf",
                    "BEGIN:VCARD\nFN:Zed\nEMAIL:zed@example.com\nEND:VCARD",
                ),
            ] {
                let touched = repo::carddav::upsert_card(
                    c,
                    20,
                    href,
                    Some("\"a1\""),
                    vcard::parse(vcf).as_ref(),
                )?;
                repo::carddav::reconcile_emails(c, &touched)?;
            }
            repo::carddav::set_book_sync_state(c, 20, Some("old"), Some("stale"), 1)
        })
        .await
        .unwrap();

        let expired = DavResponse {
            status: 403,
            etag: None,
            body: r#"<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>"#.into(),
        };
        let bob_only = MULTIGET.split("<d:response>").collect::<Vec<_>>();
        let multiget_bob = format!("{}<d:response>{}", bob_only[0], bob_only[2]);
        let t = MockTransport::new(vec![
            ms207(&gate("c9", "tok-9")),
            expired,
            ms207(LISTING),
            ms207(&multiget_bob),
        ]);
        let out = sync_account(&db, &t, 1).await.unwrap();
        assert!(out.changed);
        {
            let seen = t.seen.lock().unwrap();
            // Only Bob is new; Ann's etag matched.
            let multiget = seen[3].2.as_deref().unwrap();
            assert!(multiget.contains("bob.vcf") && !multiget.contains("ann.vcf"));
        }
        assert_eq!(
            names(&db).await,
            [
                ("ann@example.com".to_string(), Some("Ann Lee".to_string())),
                ("bob@example.com".to_string(), Some("Bob Stone".to_string())),
            ]
        );
        let state = db
            .read(|c| repo::carddav::book_sync_state(c, 20))
            .await
            .unwrap();
        assert_eq!(state, (Some("c9".into()), Some("tok-9".into())));
    }

    #[tokio::test]
    async fn failing_book_is_reported_without_stopping_the_pull() {
        let (db, _dir) = seed_db().await;
        let server_error = DavResponse {
            status: 500,
            etag: None,
            body: String::new(),
        };
        let t = MockTransport::new(vec![ms207(&gate("c1", "tok-1")), server_error]);
        let out = sync_account(&db, &t, 1).await.unwrap();
        assert!(!out.changed);
        assert_eq!(out.errors.len(), 1);
        assert!(
            out.errors[0].starts_with("Contacts: carddav error:"),
            "{:?}",
            out.errors
        );
        // Nothing stored, so the next cycle retries from scratch.
        let state = db
            .read(|c| repo::carddav::book_sync_state(c, 20))
            .await
            .unwrap();
        assert_eq!(state, (None, None));

        // A transport failure (the exhausted mock) is a per-book error too.
        let exhausted = MockTransport::new(Vec::new());
        let out = sync_account(&db, &exhausted, 1).await.unwrap();
        assert_eq!(out.errors.len(), 1);
    }
}
