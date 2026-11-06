//! One mailbox listing, in-memory identity matching, and best-effort local repair.
use std::collections::{HashMap, HashSet};

use crate::{
    db::{repo, repo::folders::Folder, repo::messages::MessageRow},
    error::Result,
    events::CoreEvent,
    imap::{self, FetchedIdentity, Session},
    models::AccountConfig,
    provider::{self, MailboxBehavior, RemoteKey},
    sync::engine::SyncCtx,
};

const CHUNK: usize = 256;

#[derive(Default)]
pub(crate) struct Listing {
    pub complete: bool,
    pub identities: Vec<FetchedIdentity>,
    by_key: HashMap<String, Vec<FetchedIdentity>>,
}

impl Listing {
    fn insert(&mut self, identity: FetchedIdentity) {
        self.identities.push(identity.clone());
        for bucket in identity.buckets() {
            self.by_key
                .entry(bucket)
                .or_default()
                .push(identity.clone());
        }
    }

    fn matches(&self, key: &RemoteKey) -> Vec<&FetchedIdentity> {
        self.by_key
            .get(&key.bucket())
            .into_iter()
            .flatten()
            .filter(|remote| remote.matches(key))
            .collect()
    }

    pub(crate) fn absent(&self, key: &RemoteKey) -> bool {
        // A header bucket with conflicting metadata is uncertain, never absent.
        self.complete
            && key.identity_complete(&self.identities)
            && !self.by_key.contains_key(&key.bucket())
    }
}

/// Fresh complete-mailbox evidence shared with the delete executor; no throttle here.
pub(crate) async fn fetch_listing(
    session: &mut Session,
    behavior: &dyn MailboxBehavior,
    expected_exists: u32,
) -> Result<Listing> {
    let uids = imap::uid_search_all(session).await?;
    let mut listing = Listing::default();
    for chunk in uids.chunks(CHUNK) {
        for identity in imap::fetch_identities(session, &imap::uid_set(chunk), behavior).await? {
            listing.insert(identity);
        }
    }
    listing.complete = listing_complete(&uids, expected_exists, &listing.identities);
    Ok(listing)
}

fn listing_complete(uids: &[u32], expected_exists: u32, identities: &[FetchedIdentity]) -> bool {
    let searched: HashSet<_> = uids.iter().copied().collect();
    let fetched: HashSet<_> = identities.iter().map(|identity| identity.uid).collect();
    uids.len() == expected_exists as usize
        && searched.len() == uids.len()
        && !searched.contains(&0)
        && searched == fetched
        && identities.len() == fetched.len()
}

pub(crate) fn completed_move_retry_at(
    conn: &rusqlite::Connection,
    id: i64,
    now: i64,
) -> Result<Option<i64>> {
    let finished: Option<i64> = conn.query_row(
        "SELECT max(finished_at) FROM pending_actions WHERE message_id=?1 AND state='done'
         AND kind IN ('move','trash') AND finished_at>=?2",
        rusqlite::params![id, now.saturating_sub(5 * 60_000)],
        |row| row.get(0),
    )?;
    Ok(finished
        .map(|at| at.saturating_add(5 * 60_000))
        .filter(|at| *at > now))
}

pub(super) fn recent_completed_move(conn: &rusqlite::Connection, id: i64) -> Result<bool> {
    Ok(completed_move_retry_at(conn, id, crate::models::now_ms())?.is_some())
}

fn candidates(
    conn: &rusqlite::Connection,
    folder_id: i64,
    account_id: i64,
    stable: bool,
) -> Result<Vec<MessageRow>> {
    if !repo::folders::is_permanent_delete_trash(conn, folder_id)? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT id FROM messages WHERE folder_id=?1 AND account_id=?2
        AND (uid IS NULL OR (?3 AND gm_msgid IS NULL))",
    )?;
    let ids = stmt
        .query_map(rusqlite::params![folder_id, account_id, stable], |row| {
            row.get::<_, i64>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut rows = Vec::new();
    for id in ids {
        let candidate = (|| -> Result<Option<MessageRow>> {
            let Some(row) = repo::messages::get_row(conn, id)? else {
                return Ok(None);
            };
            if repo::actions::has_pending_for_message(conn, id)?
                || (row.uid.is_none() && recent_completed_move(conn, id)?)
            {
                return Ok(None);
            }
            Ok(Some(row))
        })();
        match candidate {
            Ok(Some(row)) => rows.push(row),
            Err(error) => tracing::warn!(id, %error, "Trash candidate skipped"),
            _ => {}
        }
    }
    Ok(rows)
}

fn listing_due(
    previous: Option<&imap::ReconcileStamp>,
    state: (Option<i64>, Option<i64>, u32),
    now: std::time::Instant,
) -> bool {
    previous.is_none_or(|(old, at)| *old != state || now.duration_since(*at).as_secs() >= 600)
}

/// The caller has selected this Trash folder. Errors never escape identity
/// bookkeeping; an incomplete listing can never authorize ghost deletion.
pub async fn reconcile_missing_trash_uids(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
    folder: &Folder,
    selected: &imap::SelectedFolder,
) {
    if let Err(error) = reconcile(ctx, config, session, folder, selected).await {
        tracing::warn!(folder_id = folder.id, %error, "Trash identity reconciliation skipped");
    }
}

async fn reconcile(
    ctx: &SyncCtx,
    config: &AccountConfig,
    session: &mut Session,
    folder: &Folder,
    selected: &imap::SelectedFolder,
) -> Result<()> {
    let state = (selected.uid_validity, selected.uid_next, selected.exists);
    if !listing_due(
        session.reconcile_stamps.get(&folder.imap_name),
        state,
        std::time::Instant::now(),
    ) {
        return Ok(());
    }
    let (folder_id, account_id) = (folder.id, config.id);
    // Snapshot before the network listing: a newly enqueued local move must not
    // be considered absent merely because it arrived after the server snapshot.
    let caps = session.server_caps().await?;
    let behavior = provider::behavior_for(config.provider, &caps);
    let stable = !behavior.identity_fetch_items().is_empty();
    let candidates = ctx
        .db
        .read(move |conn| candidates(conn, folder_id, account_id, stable))
        .await?;
    if candidates.is_empty() || folder.uidvalidity.is_none() {
        return Ok(());
    }
    let keyed: Vec<_> = candidates
        .into_iter()
        .filter_map(|row| behavior.remote_key(&row).map(|key| (row, key)))
        .collect();
    if keyed.is_empty() {
        return Ok(());
    }
    let listing = fetch_listing(session, behavior.as_ref(), selected.exists).await?;
    let complete = listing.complete;
    if complete {
        session
            .reconcile_stamps
            .insert(folder.imap_name.clone(), (state, std::time::Instant::now()));
    }
    let mut claims: HashMap<u32, usize> = HashMap::new();
    for (_, key) in keyed.iter().filter(|(row, _)| row.uid.is_none()) {
        for remote in listing.matches(key) {
            *claims.entry(remote.uid).or_default() += 1;
        }
    }
    let validity = folder.uidvalidity;
    let changed = ctx
        .db
        .write(move |conn| {
            let mut changed = Vec::new();
            for (row, key) in keyed {
                let matches = listing.matches(&key);
                // Stable-key duplicates are still ambiguous for adopting a *single*
                // local UID. They are not absent and must never be ghost-cleaned.
                let adopt = (complete && matches.len() == 1 && claims.get(&matches[0].uid) == Some(&1))
                    .then(|| matches[0]);
                if let Some(uid) = row.uid {
                    if let Some(remote) = listing.identities.iter().find(|remote| remote.uid as i64 == uid && remote.matches(&key))
                        && let Err(error) = backfill_existing_identity(conn, &row, remote, validity)
                    {
                        tracing::warn!(message_id = row.id, %error, "Trash stable identity backfill skipped");
                    }
                    continue;
                }
                let absent = listing.absent(&key);
                if adopt.is_none() && !absent {
                    continue;
                }
                let result = repair_row(conn, &row, adopt, absent, validity);
                match result {
                    Ok(Some(tid)) => {
                        if !changed.contains(&tid) {
                            changed.push(tid);
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        tracing::warn!(message_id = row.id, %error, "Trash row repair skipped")
                    }
                }
            }
            Ok(changed)
        })
        .await?;
    if !changed.is_empty() {
        ctx.bus.emit(CoreEvent::MailUpdated {
            thread_ids: changed,
        });
    }
    Ok(())
}

fn backfill_existing_identity(
    conn: &rusqlite::Connection,
    row: &MessageRow,
    remote: &FetchedIdentity,
    validity: Option<i64>,
) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    let unchanged: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE id=?1 AND folder_id=?2 AND uid=?3
         AND account_id=?4 AND message_id IS ?5 AND internal_date IS ?6 AND size IS ?7
         AND EXISTS(SELECT 1 FROM folders WHERE id=?2 AND uidvalidity IS ?8))",
        rusqlite::params![
            row.id,
            row.folder_id,
            remote.uid,
            row.account_id,
            row.message_id,
            row.internal_date,
            row.size,
            validity
        ],
        |r| r.get(0),
    )?;
    if unchanged {
        provider::persist_identity(&tx, row.id, remote)?;
    }
    tx.commit()?;
    Ok(())
}

fn repair_row(
    conn: &mut rusqlite::Connection,
    snapshot: &MessageRow,
    remote: Option<&FetchedIdentity>,
    absent: bool,
    validity: Option<i64>,
) -> Result<Option<i64>> {
    let tx = conn.transaction()?;
    let Some(row) = repo::messages::get_row(&tx, snapshot.id)? else {
        return Ok(None);
    };
    let Some(folder_id) = row.folder_id else {
        return Ok(None);
    };
    if row.uid.is_some()
        || row.folder_id != snapshot.folder_id
        || row.account_id != snapshot.account_id
        || row.message_id != snapshot.message_id
        || row.gm_msgid != snapshot.gm_msgid
        || row.internal_date != snapshot.internal_date
        || row.size != snapshot.size
        || repo::actions::has_pending_for_message(&tx, row.id)?
        || recent_completed_move(&tx, row.id)?
        || !repo::folders::is_permanent_delete_trash(&tx, folder_id)?
        || repo::folders::get(&tx, folder_id)?.is_none_or(|f| f.uidvalidity != validity)
    {
        return Ok(None);
    }
    if let Some(remote) = remote {
        if remote.uid == 0
            || repo::messages::by_folder_uid(&tx, folder_id, remote.uid as i64)?.is_some()
        {
            return Ok(None);
        }
        tx.execute(
            "UPDATE messages SET uid=?2 WHERE id=?1",
            rusqlite::params![row.id, remote.uid],
        )?;
        provider::persist_identity(&tx, row.id, remote)?;
    } else if absent {
        repo::messages::delete(&tx, row.id)?;
    } else {
        return Ok(None);
    }
    if let Some(tid) = row.thread_id {
        repo::threads::recompute(&tx, tid)?;
    }
    tx.commit()?;
    Ok(row.thread_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testutil;

    fn identity(uid: u32) -> FetchedIdentity {
        FetchedIdentity {
            header_fetched: true,
            uid,
            gm_msgid: Some("123".into()),
            message_id: Some("same@test".into()),
            internal_date: Some(100),
            size: Some(42),
        }
    }

    fn setup() -> (rusqlite::Connection, MessageRow) {
        let conn = testutil::conn();
        testutil::seed_account(&conn);
        conn.execute("INSERT INTO folders(id,account_id,imap_name,role,uidvalidity) VALUES(2,1,'Trash','trash',9)", []).unwrap();
        let (_, id) = testutil::seed_message(&conn, "a@test", "subject", false);
        conn.execute(
            "UPDATE messages SET folder_id=2,uid=NULL,message_id='same@test' WHERE id=?1",
            [id],
        )
        .unwrap();
        let row = repo::messages::get_row(&conn, id).unwrap().unwrap();
        (conn, row)
    }

    #[test]
    fn indexes_stable_keys_and_normalized_header_with_metadata() {
        let mut listing = Listing::default();
        listing.insert(identity(7));
        for key in [
            RemoteKey::GmailMsgId(123),
            RemoteKey::Header {
                message_id: "same@test".into(),
                internal_date: Some(100),
                size: Some(42),
            },
        ] {
            assert_eq!(listing.matches(&key)[0].uid, 7);
        }
        assert!(
            listing
                .matches(&RemoteKey::Header {
                    message_id: "same@test".into(),
                    internal_date: Some(101),
                    size: Some(42),
                })
                .is_empty()
        );
        listing.insert(identity(8));
        assert_eq!(listing.matches(&RemoteKey::GmailMsgId(123)).len(), 2);
    }

    #[test]
    fn absent_requires_complete_listing_but_not_unrelated_identifiability() {
        let key = RemoteKey::Header {
            message_id: "missing@test".into(),
            internal_date: Some(100),
            size: Some(42),
        };
        let mut malformed = identity(8);
        malformed.message_id = None;
        malformed.gm_msgid = None;
        let mut listing = Listing::default();
        assert!(!listing.absent(&key));
        listing.complete = true;
        assert!(listing.absent(&key));
        listing.insert(malformed);
        assert!(listing.absent(&key));
        let mut listing = Listing::default();
        let remote = identity(7);
        listing.insert(remote.clone());
        let conflicting = RemoteKey::Header {
            message_id: "same@test".into(),
            internal_date: Some(101),
            size: Some(42),
        };
        assert!(listing.matches(&conflicting).is_empty());
        listing.complete = true;
        assert!(!listing.absent(&conflicting));
    }

    #[test]
    fn listing_completeness_requires_exact_search_and_fetch_coverage() {
        assert!(listing_complete(&[], 0, &[]));
        assert!(listing_complete(&[7, 8], 2, &[identity(7), identity(8)]));
        assert!(!listing_complete(&[], 1, &[]));
        assert!(!listing_complete(&[7, 8], 2, &[identity(7)]));
        assert!(!listing_complete(&[7], 1, &[identity(7), identity(8)]));
        assert!(!listing_complete(&[7, 7], 2, &[identity(7)]));
        assert!(!listing_complete(&[7], 1, &[identity(7), identity(7)]));
        assert!(!listing_complete(&[0], 1, &[identity(0)]));
    }

    #[test]
    fn candidates_include_known_uids_only_when_stable_identity_is_supported_and_missing() {
        let (conn, row) = setup();
        assert_eq!(candidates(&conn, 2, 1, false).unwrap().len(), 1);
        conn.execute("UPDATE messages SET uid=7 WHERE id=?1", [row.id])
            .unwrap();
        assert!(candidates(&conn, 2, 1, false).unwrap().is_empty());
        assert_eq!(candidates(&conn, 2, 1, true).unwrap().len(), 1);
        conn.execute("UPDATE messages SET gm_msgid='123' WHERE id=?1", [row.id])
            .unwrap();
        assert!(candidates(&conn, 2, 1, true).unwrap().is_empty());
        conn.execute("UPDATE messages SET uid=NULL WHERE id=?1", [row.id])
            .unwrap();
        assert_eq!(candidates(&conn, 2, 1, false).unwrap().len(), 1);
    }

    #[test]
    fn recent_completed_move_defers_candidates_and_transactional_ghost_cleanup() {
        for kind in ["move", "trash"] {
            let (mut conn, row) = setup();
            // Snapshot before completion: repair must recheck inside its transaction.
            assert_eq!(candidates(&conn, 2, 1, false).unwrap().len(), 1);
            conn.execute("INSERT INTO pending_actions(account_id,message_id,kind,payload,state,created_at,finished_at)
                VALUES(1,?1,?2,'{}','done',0,?3)",
                rusqlite::params![row.id, kind, crate::models::now_ms()]).unwrap();
            assert!(candidates(&conn, 2, 1, false).unwrap().is_empty());
            repair_row(&mut conn, &row, None, true, Some(9)).unwrap();
            assert!(repo::messages::get_row(&conn, row.id).unwrap().is_some());
            conn.execute(
                "UPDATE pending_actions SET finished_at=?1 WHERE message_id=?2",
                rusqlite::params![crate::models::now_ms() - 5 * 60_000 - 1, row.id],
            )
            .unwrap();
            assert_eq!(candidates(&conn, 2, 1, false).unwrap().len(), 1);
            repair_row(&mut conn, &row, None, true, Some(9)).unwrap();
            assert!(repo::messages::get_row(&conn, row.id).unwrap().is_none());
        }
    }

    #[test]
    fn omitted_header_blocks_absence_without_invalidating_stable_keys() {
        let mut listing = Listing {
            complete: true,
            ..Default::default()
        };
        let mut remote = identity(7);
        remote.header_fetched = false;
        remote.message_id = None;
        listing.insert(remote);
        let header = RemoteKey::Header {
            message_id: "missing@test".into(),
            internal_date: None,
            size: None,
        };
        assert!(!listing.absent(&header));
        assert!(listing.absent(&RemoteKey::GmailMsgId(456)));
        // A received header genuinely lacking Message-ID is different from an
        // omitted section and can establish that this is an unrelated message.
        let mut listing = Listing {
            complete: true,
            ..Default::default()
        };
        let mut remote = identity(7);
        remote.message_id = None;
        listing.insert(remote);
        assert!(listing.absent(&header));
    }

    #[test]
    fn complete_listing_is_throttled_until_state_changes_or_ten_minutes() {
        let now = std::time::Instant::now();
        let state = (Some(9), Some(8), 2);
        let previous = (state, now);
        assert!(listing_due(None, state, now));
        assert!(!listing_due(
            Some(&previous),
            state,
            now + std::time::Duration::from_secs(599)
        ));
        assert!(listing_due(
            Some(&previous),
            state,
            now + std::time::Duration::from_secs(600)
        ));
        for state in [
            (Some(10), Some(8), 2),
            (Some(9), Some(9), 2),
            (Some(9), Some(8), 1),
        ] {
            assert!(listing_due(Some(&previous), state, now));
        }
    }

    #[test]
    fn existing_uid_rows_gain_stable_identity_without_overwriting_it() {
        let (conn, row) = setup();
        conn.execute("UPDATE messages SET uid=7 WHERE id=?1", [row.id])
            .unwrap();
        let row = repo::messages::get_row(&conn, row.id).unwrap().unwrap();
        backfill_existing_identity(&conn, &row, &identity(7), Some(10)).unwrap();
        assert_eq!(
            repo::messages::get_row(&conn, row.id)
                .unwrap()
                .unwrap()
                .gm_msgid,
            None
        );
        backfill_existing_identity(&conn, &row, &identity(7), Some(9)).unwrap();
        assert_eq!(
            repo::messages::get_row(&conn, row.id)
                .unwrap()
                .unwrap()
                .gm_msgid
                .as_deref(),
            Some("123")
        );
        let mut changed = identity(7);
        changed.gm_msgid = Some("456".into());
        backfill_existing_identity(&conn, &row, &changed, Some(9)).unwrap();
        assert_eq!(
            repo::messages::get_row(&conn, row.id)
                .unwrap()
                .unwrap()
                .gm_msgid
                .as_deref(),
            Some("123")
        );
    }

    #[test]
    fn adopts_identity_and_removes_only_absent_ghosts() {
        let (mut conn, row) = setup();
        repair_row(&mut conn, &row, Some(&identity(7)), false, Some(9)).unwrap();
        let adopted = repo::messages::get_row(&conn, row.id).unwrap().unwrap();
        assert_eq!(adopted.uid, Some(7));
        assert_eq!(adopted.gm_msgid.as_deref(), Some("123"));
        // An old listing must not delete a row repaired in the meantime.
        repair_row(&mut conn, &row, None, true, Some(9)).unwrap();
        assert!(repo::messages::get_row(&conn, row.id).unwrap().is_some());
        let (mut conn, row) = setup();
        repair_row(&mut conn, &row, None, false, Some(9)).unwrap();
        assert!(repo::messages::get_row(&conn, row.id).unwrap().is_some());
        repair_row(&mut conn, &row, None, true, Some(9)).unwrap();
        assert!(repo::messages::get_row(&conn, row.id).unwrap().is_none());
    }

    #[test]
    fn active_actions_and_changed_validity_block_ghost_cleanup() {
        let (mut conn, row) = setup();
        repair_row(&mut conn, &row, None, true, Some(10)).unwrap();
        assert!(repo::messages::get_row(&conn, row.id).unwrap().is_some());
        conn.execute("INSERT INTO pending_actions(account_id,message_id,kind,payload,state,created_at) VALUES(1,?1,'trash','{}','pending',0)", [row.id]).unwrap();
        repair_row(&mut conn, &row, None, true, Some(9)).unwrap();
        assert!(repo::messages::get_row(&conn, row.id).unwrap().is_some());
        repair_row(&mut conn, &row, Some(&identity(7)), false, Some(9)).unwrap();
        assert_eq!(
            repo::messages::get_row(&conn, row.id).unwrap().unwrap().uid,
            None
        );
    }

    #[test]
    fn per_row_error_rolls_back_without_preventing_next_repair() {
        let (mut conn, row) = setup();
        let (_, other) = testutil::seed_message(&conn, "b@test", "other", false);
        conn.execute(
            "UPDATE messages SET folder_id=2,uid=NULL WHERE id=?1",
            [other],
        )
        .unwrap();
        let next = repo::messages::get_row(&conn, other).unwrap().unwrap();
        conn.execute_batch(&format!("CREATE TRIGGER fail_one BEFORE UPDATE OF uid ON messages WHEN OLD.id={} BEGIN SELECT RAISE(FAIL,'test error'); END;", row.id)).unwrap();
        assert!(repair_row(&mut conn, &row, Some(&identity(7)), false, Some(9)).is_err());
        repair_row(&mut conn, &next, Some(&identity(8)), false, Some(9)).unwrap();
        assert_eq!(
            repo::messages::get_row(&conn, next.id)
                .unwrap()
                .unwrap()
                .uid,
            Some(8)
        );
        assert_eq!(
            repo::messages::get_row(&conn, row.id).unwrap().unwrap().uid,
            None
        );
    }
}
