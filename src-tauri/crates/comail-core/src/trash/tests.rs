use super::*;
use crate::{db::testutil, models::ActionKind};

fn fixture() -> (Connection, i64, i64) {
    let c = testutil::conn();
    testutil::seed_account(&c);
    c.execute("INSERT INTO folders (id,account_id,imap_name,role,uidvalidity) VALUES (2,1,'Trash','trash',42)", []).unwrap();
    let (tid, mid) = testutil::seed_message(&c, "sender@example.invalid", "Delete fixture", false);
    c.execute(
        "UPDATE messages SET folder_id=2, uid=7, message_id='<delete@example.invalid>' WHERE id=?1",
        [mid],
    )
    .unwrap();
    (c, tid, mid)
}

fn legacy_fixture() -> (Connection, i64, i64) {
    let (c, tid, mid) = fixture();
    c.execute_batch(
        "UPDATE accounts SET provider='gmail' WHERE id=1;
        UPDATE folders SET imap_name='Deleted Items',role_source='name' WHERE id=2;
        INSERT INTO folders(id,account_id,imap_name,role,role_source,uidvalidity)
        VALUES(3,1,'[Gmail]/Canonical','trash','special_use',99);",
    )
    .unwrap();
    let id = repo::actions::enqueue(
        &c,
        1,
        "trash",
        Some(mid),
        Some(tid),
        &serde_json::json!({"targetFolderId":2}),
        None,
    )
    .unwrap();
    repo::actions::set_state(&c, id, "done", None).unwrap();
    repo::folders::normalize_roles(&c, Some(1)).unwrap();
    (c, tid, mid)
}

#[test]
fn legacy_repair_requires_done_trash_intent_and_is_idempotent() {
    let (mut c, tid, mid) = legacy_fixture();
    let mut untouched = Vec::new();
    for (kind, state, target) in [
        ("trash", "pending", 2),
        ("move", "done", 2),
        ("trash", "done", 1),
        ("trash", "failed", 2),
    ] {
        let (other_tid, other) = testutil::seed_message(&c, "other@test", "ordinary label", false);
        c.execute("UPDATE messages SET folder_id=2 WHERE id=?1", [other])
            .unwrap();
        let id = repo::actions::enqueue(
            &c,
            1,
            kind,
            Some(other),
            Some(other_tid),
            &serde_json::json!({"targetFolderId":target}),
            None,
        )
        .unwrap();
        repo::actions::set_state(&c, id, state, None).unwrap();
        untouched.push(other);
    }
    let (_, no_history) = testutil::seed_message(&c, "other@test", "no history", false);
    c.execute("UPDATE messages SET folder_id=2 WHERE id=?1", [no_history])
        .unwrap();
    untouched.push(no_history);
    assert_eq!(repair_legacy_trash_intent(&mut c).unwrap(), 1);
    let repaired = repo::messages::get_row(&c, mid).unwrap().unwrap();
    assert_eq!((repaired.folder_id, repaired.uid), (Some(3), None));
    assert!(repo::threads::get_summary(&c, tid).unwrap().is_some());
    for id in untouched {
        assert_eq!(
            repo::messages::get_row(&c, id).unwrap().unwrap().folder_id,
            Some(2)
        );
    }
    let moves = repo::actions::due(&c, 1, i64::MAX, 20).unwrap();
    let moved = moves.iter().find(|a| a.message_id == Some(mid)).unwrap();
    assert_eq!(moved.kind, "trash");
    assert_eq!(moved.payload["srcFolderId"], 2);
    assert_eq!(moved.payload["srcUid"], 7);
    assert_eq!(moved.payload["srcUidValidity"], 42);
    assert_eq!(moved.payload["targetFolderId"], 3);
    assert_eq!(repair_legacy_trash_intent(&mut c).unwrap(), 0);
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM folder_role_repairs WHERE completed=0",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        moves.len(),
        repo::actions::due(&c, 1, i64::MAX, 20).unwrap().len()
    );
    // A later discovery may recognize the same heuristic name again, but the
    // completed marker prevents scanning old intent a second time.
    c.execute(
        "UPDATE folders SET role='trash',role_source='name' WHERE id=2",
        [],
    )
    .unwrap();
    repo::folders::normalize_roles(&c, Some(1)).unwrap();
    assert_eq!(repair_legacy_trash_intent(&mut c).unwrap(), 0);
    assert_eq!(
        c.query_row(
            "SELECT completed FROM folder_role_repairs WHERE folder_id=2",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn legacy_repair_keeps_evidence_until_canonical_trash_exists_and_rolls_back_on_error() {
    let (mut c, _, mid) = legacy_fixture();
    c.execute("UPDATE folders SET role=NULL WHERE id=3", [])
        .unwrap();
    assert_eq!(repair_legacy_trash_intent(&mut c).unwrap(), 0);
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM folder_role_repairs WHERE completed=0",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    c.execute("UPDATE folders SET role='trash' WHERE id=3", [])
        .unwrap();
    c.execute_batch(
        "CREATE TRIGGER fail_repair BEFORE INSERT ON pending_actions
        WHEN NEW.kind='trash' BEGIN SELECT RAISE(FAIL,'repair test'); END;",
    )
    .unwrap();
    assert!(repair_legacy_trash_intent(&mut c).is_err());
    let row = repo::messages::get_row(&c, mid).unwrap().unwrap();
    assert_eq!((row.folder_id, row.uid), (Some(2), Some(7)));
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM folder_role_repairs WHERE completed=0",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    c.execute_batch("DROP TRIGGER fail_repair").unwrap();
    assert_eq!(repair_legacy_trash_intent(&mut c).unwrap(), 1);
}

#[test]
fn noncanonical_trash_enqueues_normal_move_before_delete_once() {
    let (mut c, tid, mid) = fixture();
    c.execute_batch(
        "UPDATE folders SET imap_name='Deleted Items',role_source='name' WHERE id=2;
        INSERT INTO folders(id,account_id,imap_name,role,role_source,uidvalidity)
        VALUES(3,1,'Trash','trash','special_use',99);",
    )
    .unwrap();
    let ids = enqueue(&mut c, &[tid]).unwrap();
    assert_eq!(ids.len(), 1);
    let delete = repo::actions::get(&c, ids[0].0).unwrap().unwrap();
    assert_eq!(delete.kind, KIND);
    assert_eq!(delete.payload["folderId"], 3);
    assert_eq!(delete.payload["uidValidity"], 99);
    assert!(delete.payload["uid"].is_null());
    let due = repo::actions::due(&c, 1, i64::MAX, 20).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].kind, "trash");
    assert_eq!(due[0].payload["srcFolderId"], 2);
    assert_eq!(due[0].payload["srcUid"], 7);
    assert_eq!(due[0].payload["targetFolderId"], 3);
    assert!(due[0].id < delete.id);
    assert_eq!(
        repo::messages::get_row(&c, mid).unwrap().unwrap().folder_id,
        Some(3)
    );
    assert_eq!(enqueue(&mut c, &[tid]).unwrap(), ids);
    assert_eq!(
        c.query_row("SELECT count(*) FROM pending_actions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    repo::actions::set_state(&c, due[0].id, "done", None).unwrap();
    assert_eq!(
        repo::actions::due(&c, 1, i64::MAX, 20).unwrap()[0].id,
        delete.id
    );
}

#[test]
fn delete_without_canonical_trash_rejects_atomically() {
    let (mut c, tid, mid) = fixture();
    c.execute_batch(
        "UPDATE accounts SET provider='gmail' WHERE id=1;
        UPDATE folders SET role_source='name' WHERE id=2;",
    )
    .unwrap();
    assert!(matches!(
        enqueue(&mut c, &[tid]),
        Err(CoreError::DeleteRejected(_))
    ));
    assert_eq!(
        repo::messages::get_row(&c, mid).unwrap().unwrap().folder_id,
        Some(2)
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM pending_actions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(repo::threads::get_summary(&c, tid).unwrap().is_some());
}

#[test]
fn queues_trash_only_and_keeps_data_until_confirmation() {
    let (mut c, tid, mid) = fixture();
    let (_, inbox) = testutil::seed_message(&c, "sender@example.invalid", "Reply", false);
    c.execute(
        "UPDATE messages SET thread_id=?1 WHERE id=?2",
        params![tid, inbox],
    )
    .unwrap();
    let ids = enqueue(&mut c, &[tid, tid]).unwrap();
    assert_eq!(ids.len(), 1);
    assert!(repo::messages::get_row(&c, mid).unwrap().is_some());
    assert!(repo::messages::get_row(&c, inbox).unwrap().is_some());
    let action = repo::actions::get(&c, ids[0].0).unwrap().unwrap();
    assert_eq!(action.payload["uidValidity"], 42);
    assert_eq!(action.payload["uid"], 7);
    assert!(action.payload["remoteKey"].is_object());
    assert_eq!(action.message_id, Some(mid));
    assert!(repo::actions::last_undoable(&c, 0).unwrap().is_none());
    assert_eq!(enqueue(&mut c, &[tid]).unwrap(), ids);
    assert!(crate::apply_thread_action(&mut c, tid, ActionKind::Move, None).is_err());
    assert_eq!(
        c.query_row("SELECT count(*) FROM visible_messages", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn uidless_trash_and_pending_moves_are_accepted_and_hidden() {
    let (mut c, tid, mid) = fixture();
    c.execute("UPDATE messages SET uid=NULL WHERE id=?1", [mid])
        .unwrap();
    c.execute("UPDATE folders SET uidvalidity=NULL WHERE id=2", [])
        .unwrap();
    let moving = repo::actions::enqueue(
        &c,
        1,
        "trash",
        Some(mid),
        Some(tid),
        &serde_json::json!({"srcFolderId":1,"srcUid":7}),
        None,
    )
    .unwrap();
    let ids = enqueue(&mut c, &[tid]).unwrap();
    assert_eq!(ids.len(), 1);
    assert_eq!(
        c.query_row("SELECT count(*) FROM visible_messages", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let action = repo::actions::get(&c, ids[0].0).unwrap().unwrap();
    assert!(action.payload["uid"].is_null());
    assert!(action.payload["uidValidity"].is_null());
    let due = repo::actions::due(&c, 1, i64::MAX, 20).unwrap();
    assert_eq!(due.iter().map(|a| a.id).collect::<Vec<_>>(), vec![moving]);
    repo::actions::set_state(&c, moving, "done", None).unwrap();
    assert_eq!(
        repo::actions::due(&c, 1, i64::MAX, 20).unwrap()[0].id,
        ids[0].0
    );
}

#[test]
fn account_mismatch_and_non_trash_messages_are_not_queued() {
    let (mut c, tid, _) = fixture();
    c.execute_batch("UPDATE folders SET role='inbox' WHERE id=2")
        .unwrap();
    assert!(enqueue(&mut c, &[tid]).unwrap().is_empty());
    c.execute_batch("INSERT INTO accounts (id,email,provider,auth_kind,username,imap_host,imap_port,smtp_host,smtp_port,created_at)
        VALUES (2,'other@example.invalid','imap','password','other','h',993,'h',587,0);
        UPDATE folders SET account_id=2,role='trash' WHERE id=2;").unwrap();
    assert!(enqueue(&mut c, &[tid]).unwrap().is_empty());
}

#[test]
fn confirmed_commit_deletes_uidless_identity_but_not_reused_row() {
    for replaced in [false, true] {
        let (mut c, tid, mid) = fixture();
        c.execute("UPDATE messages SET uid=NULL WHERE id=?1", [mid])
            .unwrap();
        let ids = enqueue(&mut c, &[tid]).unwrap();
        let action = repo::actions::get(&c, ids[0].0).unwrap().unwrap();
        let target: Target = serde_json::from_value(action.payload).unwrap();
        if replaced {
            c.execute(
                "UPDATE messages SET message_id='<unrelated>' WHERE id=?1",
                [mid],
            )
            .unwrap();
        }
        commit_confirmed(&mut c, &[(ids[0].0, target)]).unwrap();
        assert_eq!(
            repo::messages::get_row(&c, mid).unwrap().is_some(),
            replaced
        );
        assert_eq!(
            repo::actions::get(&c, ids[0].0).unwrap().unwrap().state,
            "done"
        );
    }
}

#[test]
fn failed_preflight_restores_visibility_and_allows_retry() {
    let (mut c, tid, mid) = fixture();
    let ids = enqueue(&mut c, &[tid]).unwrap();
    assert!(repo::threads::get_summary(&c, tid).unwrap().is_none());
    repo::actions::set_state(&c, ids[0].0, "failed", Some("unsupported UIDPLUS")).unwrap();
    repo::threads::recompute(&c, tid).unwrap();
    assert!(repo::threads::get_summary(&c, tid).unwrap().is_some());
    assert!(repo::messages::get_row(&c, mid).unwrap().is_some());
    assert_ne!(enqueue(&mut c, &[tid]).unwrap(), ids);
}

#[test]
fn no_artificial_conversation_cap() {
    let (mut c, tid, _) = fixture();
    assert!(enqueue(&mut c, &[]).unwrap().is_empty());
    assert_eq!(enqueue(&mut c, &vec![tid; 501]).unwrap().len(), 1);
}

#[test]
fn replacement_rows_cannot_override_queued_remote_identity() {
    let (mut c, tid, mid) = fixture();
    let ids = enqueue(&mut c, &[tid]).unwrap();
    let action = repo::actions::get(&c, ids[0].0).unwrap().unwrap();
    let target: Target = serde_json::from_value(action.payload).unwrap();
    let original = repo::messages::get_row(&c, mid).unwrap().unwrap();
    assert!(key_matches_row(target.remote_key.as_ref(), &original));
    c.execute(
        "UPDATE messages SET message_id='<unrelated>' WHERE id=?1",
        [mid],
    )
    .unwrap();
    let replacement = repo::messages::get_row(&c, mid).unwrap().unwrap();
    assert!(!key_matches_row(target.remote_key.as_ref(), &replacement));
    repo::messages::delete(&c, mid).unwrap();
    // SQLite may reuse an ID, even with the same header identity. The durable
    // action FK was cleared and must not authorize deleting this replacement.
    c.execute("INSERT INTO messages(id,account_id,thread_id,folder_id,message_id,subject,date) VALUES(?1,1,?2,2,'<delete@example.invalid>','replacement',1)", params![mid, tid]).unwrap();
    commit_confirmed(&mut c, &[(ids[0].0, target)]).unwrap();
    assert!(repo::messages::get_row(&c, mid).unwrap().is_some());
}

#[test]
fn uncertain_remote_attempt_is_not_a_terminal_preflight_failure() {
    assert!(matches!(
        preflight_error(false, "no UIDPLUS"),
        CoreError::DeleteRejected(_)
    ));
    assert!(matches!(
        preflight_error(true, "no UIDPLUS"),
        CoreError::Other(_)
    ));
}

struct FakeIdentity {
    complete_absent: bool,
    verified: bool,
    hits: Vec<u32>,
    calls: Vec<&'static str>,
}
impl IdentityOps for FakeIdentity {
    async fn verify(
        &mut self,
        uid: u32,
        _key: &RemoteKey,
    ) -> Result<Option<imap::FetchedIdentity>> {
        self.calls.push("verify");
        Ok(self.verified.then(|| fetched(uid)))
    }
    async fn search(&mut self, _key: &RemoteKey) -> Result<Vec<imap::FetchedIdentity>> {
        self.calls.push("search");
        Ok(self.hits.iter().copied().map(fetched).collect())
    }
    async fn confirm_absent(&mut self, _key: &RemoteKey) -> Result<bool> {
        self.calls.push("listing");
        Ok(self.complete_absent)
    }
}
fn fetched(uid: u32) -> imap::FetchedIdentity {
    imap::FetchedIdentity {
        header_fetched: true,
        uid,
        gm_msgid: Some("123".into()),
        message_id: Some("<x@y>".into()),
        internal_date: Some(123),
        size: Some(456),
    }
}
fn uids(found: Vec<imap::FetchedIdentity>) -> Vec<u32> {
    found.into_iter().map(|identity| identity.uid).collect()
}
fn keys() -> Vec<RemoteKey> {
    vec![
        RemoteKey::GmailMsgId(123),
        RemoteKey::EmailId("M123".into()),
        RemoteKey::Header {
            message_id: "<x@y>".into(),
            internal_date: Some(123),
            size: Some(456),
        },
    ]
}
fn target(key: RemoteKey, uid: Option<u32>) -> Target {
    Target {
        message_id: 1,
        thread_id: 1,
        account_id: 1,
        folder_id: 2,
        uid,
        uid_validity: Some(42),
        remote_key: Some(key),
    }
}

#[tokio::test]
async fn known_uid_is_verified_for_every_key_and_stale_namespace_stops_before_fetch() {
    for key in keys() {
        let mut fake = FakeIdentity {
            complete_absent: false,
            verified: true,
            hits: vec![],
            calls: vec![],
        };
        let t = target(key, Some(7));
        assert_eq!(
            uids(
                resolve_target(&mut fake, &t, Some(42), false)
                    .await
                    .unwrap()
            ),
            vec![7]
        );
        assert_eq!(fake.calls, ["verify"]);
        fake.calls.clear();
        assert!(matches!(
            resolve_target(&mut fake, &t, Some(43), false).await,
            Err(CoreError::DeleteRejected(_))
        ));
        assert!(fake.calls.is_empty());
    }
}

#[tokio::test]
async fn unknown_uid_zero_one_many_hits_per_key() {
    for key in keys() {
        for hits in [vec![], vec![7], vec![7, 8]] {
            let mut fake = FakeIdentity {
                complete_absent: false,
                verified: false,
                hits: hits.clone(),
                calls: vec![],
            };
            let t = target(key.clone(), None);
            let result = resolve_target(&mut fake, &t, Some(42), false).await;
            if hits.is_empty() && key.is_header() {
                assert!(
                    matches!(result, Err(CoreError::ActionDeferred(_))),
                    "Header SEARCH cannot prove absence"
                );
            } else if hits.len() > 1 && !key.allows_multiple_matches() {
                assert!(matches!(result, Err(CoreError::DeleteRejected(_))));
            } else {
                assert_eq!(uids(result.unwrap()), hits);
            }
            assert_eq!(
                fake.calls,
                if hits.is_empty() && key.is_header() {
                    vec!["search", "listing"]
                } else {
                    vec!["search"]
                }
            );
        }
    }
}

#[tokio::test]
async fn header_zero_hits_require_complete_listing_before_confirming_absence() {
    for uid in [None, Some(7)] {
        for complete_absent in [false, true] {
            let key = RemoteKey::Header {
                message_id: "<purged@test>".into(),
                internal_date: Some(123),
                size: Some(456),
            };
            let mut fake = FakeIdentity {
                complete_absent,
                verified: false,
                hits: vec![],
                calls: vec![],
            };
            let result = resolve_target(&mut fake, &target(key, uid), Some(42), false).await;
            if complete_absent {
                assert!(
                    result.unwrap().is_empty(),
                    "complete absence is already-gone success"
                );
            } else {
                assert!(matches!(result, Err(CoreError::ActionDeferred(_))));
            }
            assert_eq!(
                fake.calls,
                if uid.is_some() {
                    vec!["verify", "search", "listing"]
                } else {
                    vec!["search", "listing"]
                }
            );
        }
    }
}

#[tokio::test]
async fn recent_move_defers_header_absence_but_not_verified_or_stable_identity() {
    for uid in [None, Some(7)] {
        let mut fake = FakeIdentity {
            complete_absent: true,
            verified: false,
            hits: vec![],
            calls: vec![],
        };
        let key = RemoteKey::Header {
            message_id: "<x@y>".into(),
            internal_date: Some(123),
            size: Some(456),
        };
        assert!(matches!(
            resolve_target(&mut fake, &target(key.clone(), uid), Some(42), true).await,
            Err(CoreError::ActionDeferred(_))
        ));
        assert!(
            !fake.calls.contains(&"listing"),
            "recent moves cannot authorize absence even from a complete listing"
        );
        fake.calls.clear();
        assert!(
            resolve_target(&mut fake, &target(key.clone(), uid), Some(42), false)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(fake.calls.contains(&"listing"));
        fake.hits = vec![7];
        assert_eq!(
            uids(
                resolve_target(&mut fake, &target(key, uid), Some(42), true)
                    .await
                    .unwrap()
            ),
            vec![7]
        );
        fake.hits.clear();
        assert!(
            resolve_target(
                &mut fake,
                &target(RemoteKey::GmailMsgId(123), uid),
                Some(42),
                true
            )
            .await
            .unwrap()
            .is_empty()
        );
    }
}

#[tokio::test]
async fn reused_uid_is_never_deleted_without_identity_verification() {
    let mut fake = FakeIdentity {
        complete_absent: false,
        verified: false,
        hits: vec![8],
        calls: vec![],
    };
    assert_eq!(
        uids(
            resolve_target(
                &mut fake,
                &target(RemoteKey::GmailMsgId(123), Some(7)),
                Some(42),
                false,
            )
            .await
            .unwrap()
        ),
        vec![8]
    );
    assert_eq!(fake.calls, ["verify", "search"]);
}

#[tokio::test]
async fn verified_known_and_unknown_uid_matches_backfill_and_persist_stronger_key() {
    for uid in [Some(7_i64), None] {
        let root = tempfile::tempdir().unwrap();
        let paths = crate::config::Paths::for_tests(root.path());
        let db = crate::db::Db::open(&paths.db_file()).unwrap();
        let (id, action_id, mut target) = db.write(move |conn| {
            testutil::seed_account(conn);
            conn.execute("INSERT INTO folders(id,account_id,imap_name,role,uidvalidity) VALUES(2,1,'Trash','trash',42)", [])?;
            let (tid, id) = testutil::seed_message(conn, "sender@test", "backfill", false);
            conn.execute("UPDATE messages SET folder_id=2,uid=?2,message_id='<x@y>',internal_date=123000,size=456 WHERE id=?1", params![id, uid])?;
            let action_id = enqueue(conn, &[tid])?[0].0;
            assert!(repo::actions::try_claim(conn, action_id)?);
            let action = repo::actions::get(conn, action_id)?.unwrap();
            let target = serde_json::from_value::<Target>(action.payload)?;
            Ok((id, action_id, target))
        }).await.unwrap();
        assert!(target.remote_key.as_ref().unwrap().is_header());
        let ctx = SyncCtx {
            db,
            bus: crate::events::EventBus::new(),
            paths: std::sync::Arc::new(paths),
            tokens: crate::oauth::tokens::TokenProvider::new(),
        };
        learn_remote_identity(&ctx, action_id, &mut target, &[fetched(7)])
            .await
            .unwrap();
        assert_eq!(target.remote_key, Some(RemoteKey::GmailMsgId(123)));
        let (row, payload) = ctx
            .db
            .read(move |conn| {
                Ok((
                    repo::messages::get_row(conn, id)?.unwrap(),
                    repo::actions::get(conn, action_id)?.unwrap().payload,
                ))
            })
            .await
            .unwrap();
        assert_eq!(row.gm_msgid.as_deref(), Some("123"));
        assert_eq!(
            payload["remoteKey"],
            serde_json::to_value(RemoteKey::GmailMsgId(123)).unwrap()
        );
        assert_eq!(
            row.uid, uid,
            "learning stable identity does not invent a local UID"
        );
    }
}
