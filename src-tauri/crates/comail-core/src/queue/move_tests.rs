use super::*;
use serde_json::{Value, json};

struct Fixture {
    _root: tempfile::TempDir,
    ctx: SyncCtx,
    action: repo::actions::PendingAction,
    message_id: i64,
}

async fn fixture(overrides: Value) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let paths = crate::config::Paths::for_tests(root.path());
    let db = crate::db::Db::open(&paths.db_file()).unwrap();
    let (action, message_id) = db.write(move |conn| {
        crate::db::testutil::seed_account(conn);
        conn.execute("INSERT INTO folders (id, account_id, imap_name, role, uidvalidity) VALUES (2,1,'Trash','trash',9)", [])?;
        let (thread_id, message_id) = crate::db::testutil::seed_message(conn, "sender@test.dev", "move", false);
        // Sync has already relinked a later optimistic destination. Its UID
        // must never be used in the original source folder or cleared again.
        conn.execute("UPDATE messages SET folder_id = 2, uid = 900, message_id = '<source@test.dev>' WHERE id = ?1", [message_id])?;
        let mut payload = json!({"srcFolderId": 1, "targetFolderId": 2, "srcUid": null,
            "srcUidValidity": null, "srcMessageId": "<source@test.dev>"});
        for (key, value) in overrides.as_object().unwrap() {
            payload[key] = value.clone();
        }
        let id = repo::actions::enqueue(conn, 1, "trash", Some(message_id), Some(thread_id), &payload, None)?;
        assert!(repo::actions::try_claim(conn, id)?);
        Ok((repo::actions::get(conn, id)?.unwrap(), message_id))
    }).await.unwrap();
    Fixture {
        _root: root,
        ctx: SyncCtx {
            db,
            bus: crate::events::EventBus::new(),
            paths: std::sync::Arc::new(paths),
            tokens: crate::oauth::tokens::TokenProvider::new(),
        },
        action,
        message_id,
    }
}

struct FakeRemote {
    validity: Option<i64>,
    exists: bool,
    matches: Vec<u32>,
    selected: Vec<String>,
    searched: Vec<String>,
    checked: Vec<u32>,
    moved: Vec<(u32, String)>,
    fail_move: bool,
    destination: Option<u32>,
    verified: bool,
    db: crate::db::Db,
    action_id: i64,
}

impl FakeRemote {
    fn new(fixture: &Fixture) -> Self {
        Self {
            validity: Some(9),
            exists: true,
            matches: vec![41],
            selected: vec![],
            searched: vec![],
            checked: vec![],
            moved: vec![],
            fail_move: false,
            destination: Some(501),
            verified: true,
            db: fixture.ctx.db.clone(),
            action_id: fixture.action.id,
        }
    }
}

impl MoveRemote for FakeRemote {
    async fn select_source(&mut self, folder: &str) -> Result<Option<i64>> {
        self.selected.push(folder.to_string());
        Ok(self.validity)
    }

    async fn uid_exists(&mut self, uid: u32) -> Result<bool> {
        self.checked.push(uid);
        Ok(self.exists)
    }

    async fn search_key(&mut self, key: &crate::provider::RemoteKey) -> Result<Vec<u32>> {
        let crate::provider::RemoteKey::Header { message_id, .. } = key else {
            panic!("unexpected key")
        };
        self.searched.push(format!(
            "<{}>",
            message_id.trim_start_matches('<').trim_end_matches('>')
        ));
        Ok(self.matches.clone())
    }

    async fn verify_key(&mut self, _: u32, _: &crate::provider::RemoteKey) -> Result<bool> {
        Ok(self.verified)
    }

    async fn move_uid(&mut self, uid: u32, target: &str) -> Result<Option<u32>> {
        let action_id = self.action_id;
        let stored = self
            .db
            .read(move |conn| Ok(repo::actions::get(conn, action_id)?.unwrap()))
            .await?;
        assert_eq!(stored.state, "inflight");
        assert_eq!(stored.payload["srcUid"], uid);
        assert_eq!(stored.payload["srcUidValidity"], self.validity.unwrap());
        self.moved.push((uid, target.to_string()));
        if self.fail_move {
            Err(CoreError::Imap("lost UID MOVE acknowledgement".into()))
        } else {
            Ok(self.destination)
        }
    }
}

#[tokio::test]
async fn null_uid_chained_move_resolves_and_persists_before_remote_write() {
    let fixture = fixture(json!({})).await;
    let mut remote = FakeRemote::new(&fixture);
    move_action(&fixture.ctx, &mut remote, &fixture.action)
        .await
        .unwrap();
    assert_eq!(remote.selected, ["INBOX", "Trash"]);
    assert_eq!(remote.searched, ["<source@test.dev>"]);
    assert!(remote.checked.is_empty());
    assert_eq!(remote.moved, [(41, "Trash".into())]);
    let message_id = fixture.message_id;
    let row = fixture
        .ctx
        .db
        .read(move |conn| Ok(repo::messages::get_row(conn, message_id)?.unwrap()))
        .await
        .unwrap();
    assert_eq!(row.folder_id, Some(2));
    assert_eq!(row.uid, Some(900));
}

#[tokio::test]
async fn legacy_null_validity_uses_only_message_id_from_relinked_local_row() {
    let fixture = fixture(json!({"srcUid": 7, "srcMessageId": null})).await;
    let mut remote = FakeRemote::new(&fixture);
    move_action(&fixture.ctx, &mut remote, &fixture.action)
        .await
        .unwrap();
    assert!(remote.checked.is_empty());
    assert_eq!(remote.searched, ["<source@test.dev>"]);
    assert_eq!(remote.moved[0].0, 41);
}

#[tokio::test]
async fn captured_uid_requires_matching_epoch_and_remote_existence() {
    let fixture = fixture(json!({"srcUid": 7, "srcUidValidity": 9})).await;
    let mut remote = FakeRemote::new(&fixture);
    move_action(&fixture.ctx, &mut remote, &fixture.action)
        .await
        .unwrap();
    assert_eq!(remote.checked, [7]);
    assert!(remote.searched.is_empty());
    assert_eq!(remote.moved[0].0, 7);
}

#[tokio::test]
async fn changed_epoch_never_uses_old_uid_and_requires_unique_exact_identity() {
    let fixture = fixture(json!({"srcUid": 7, "srcUidValidity": 8})).await;
    let mut remote = FakeRemote::new(&fixture);
    move_action(&fixture.ctx, &mut remote, &fixture.action)
        .await
        .unwrap();
    assert!(remote.checked.is_empty());
    assert_eq!(remote.searched, ["<source@test.dev>"]);
    assert_eq!(remote.moved[0].0, 41);
}

#[tokio::test]
async fn absent_or_ambiguous_message_id_does_not_move_or_finish() {
    for matches in [vec![], vec![41, 42], vec![0]] {
        let fixture = fixture(json!({})).await;
        let mut remote = FakeRemote::new(&fixture);
        remote.matches = matches;
        let outcome = move_action(&fixture.ctx, &mut remote, &fixture.action).await;
        assert!(matches!(outcome, Err(CoreError::ActionDeferred(_))));
        assert!(remote.moved.is_empty());
        record_outcomes(
            &fixture.ctx,
            std::slice::from_ref(&fixture.action),
            &outcome,
        )
        .await
        .unwrap();
        let id = fixture.action.id;
        let stored = fixture
            .ctx
            .db
            .read(move |conn| Ok(repo::actions::get(conn, id)?.unwrap()))
            .await
            .unwrap();
        assert_eq!(stored.state, "pending");
        assert_eq!(stored.attempts, 0);
    }
}

#[tokio::test]
async fn invalid_uid_and_validity_values_reject_before_any_remote_command() {
    for key in ["srcUid", "srcUidValidity"] {
        for invalid in [
            json!(-1),
            json!(0),
            json!(4294967296_u64),
            json!(1.5),
            json!("7"),
        ] {
            let mut overrides = json!({});
            overrides[key] = invalid;
            let fixture = fixture(overrides).await;
            let mut remote = FakeRemote::new(&fixture);
            let error = move_action(&fixture.ctx, &mut remote, &fixture.action)
                .await
                .unwrap_err();
            assert!(matches!(error, CoreError::ActionRejected(_)));
            assert!(terminal_failure("trash", 1, &error));
            assert!(remote.selected.is_empty());
            assert!(remote.moved.is_empty());
        }
    }
}

#[tokio::test]
async fn missing_uidvalidity_from_select_cannot_authorize_a_write() {
    for validity in [None, Some(0), Some(-1), Some(4294967296)] {
        let fixture = fixture(json!({"srcUid": 7, "srcUidValidity": 9})).await;
        let mut remote = FakeRemote::new(&fixture);
        remote.validity = validity;
        assert!(matches!(
            move_action(&fixture.ctx, &mut remote, &fixture.action).await,
            Err(CoreError::ActionDeferred(_))
        ));
        assert!(remote.moved.is_empty());
        assert!(remote.checked.is_empty());
    }
}

#[tokio::test]
async fn missing_local_fk_requires_remote_identity_not_silent_success() {
    let mut fixture = fixture(json!({"srcMessageId": null})).await;
    fixture.action.message_id = None;
    let mut remote = FakeRemote::new(&fixture);
    assert!(matches!(
        move_action(&fixture.ctx, &mut remote, &fixture.action).await,
        Err(CoreError::ActionDeferred(_))
    ));
    assert!(remote.moved.is_empty());
    fixture.action.payload["srcMessageId"] = json!("<source@test.dev>");
    move_action(&fixture.ctx, &mut remote, &fixture.action)
        .await
        .unwrap();
    assert_eq!(remote.moved[0].0, 41);
}

#[tokio::test]
async fn missing_folder_is_deferred_not_done() {
    let fixture = fixture(json!({"srcFolderId": 999})).await;
    let mut remote = FakeRemote::new(&fixture);
    assert!(matches!(
        move_action(&fixture.ctx, &mut remote, &fixture.action).await,
        Err(CoreError::ActionDeferred(_))
    ));
    assert!(remote.selected.is_empty());
    assert!(remote.moved.is_empty());
}

#[tokio::test]
async fn source_and_target_must_belong_to_action_account() {
    for key in ["srcFolderId", "targetFolderId"] {
        let mut fixture = fixture(json!({})).await;
        fixture.ctx.db.write(|conn| {
            conn.execute("INSERT INTO accounts (id, email, provider, auth_kind, username, imap_host, imap_port, smtp_host, smtp_port, created_at) VALUES (2,'other@test.dev','imap','password','other','h',993,'h',587,0)", [])?;
            conn.execute("INSERT INTO folders (id, account_id, imap_name) VALUES (3,2,'Foreign')", [])?;
            Ok(())
        }).await.unwrap();
        fixture.action.payload[key] = json!(3);
        let mut remote = FakeRemote::new(&fixture);
        assert!(matches!(
            move_action(&fixture.ctx, &mut remote, &fixture.action).await,
            Err(CoreError::ActionRejected(_))
        ));
        assert!(remote.selected.is_empty());
        assert!(remote.moved.is_empty());
    }
}

#[tokio::test]
async fn lost_ack_with_absent_source_stays_pending_without_destination_guess() {
    let fixture = fixture(json!({"srcUid": 7, "srcUidValidity": 9})).await;
    let mut remote = FakeRemote::new(&fixture);
    remote.fail_move = true;
    let outcome = move_action(&fixture.ctx, &mut remote, &fixture.action).await;
    assert!(matches!(outcome, Err(CoreError::Imap(_))));
    record_outcomes(
        &fixture.ctx,
        std::slice::from_ref(&fixture.action),
        &outcome,
    )
    .await
    .unwrap();
    let id = fixture.action.id;
    let retry = fixture
        .ctx
        .db
        .write(move |conn| {
            assert!(repo::actions::try_claim(conn, id)?);
            Ok(repo::actions::get(conn, id)?.unwrap())
        })
        .await
        .unwrap();
    remote.exists = false;
    remote.matches.clear();
    let outcome = move_action(&fixture.ctx, &mut remote, &retry).await;
    assert!(matches!(outcome, Err(CoreError::ActionDeferred(_))));
    record_outcomes(&fixture.ctx, &[retry], &outcome)
        .await
        .unwrap();
    let stored = fixture
        .ctx
        .db
        .read(move |conn| Ok(repo::actions::get(conn, id)?.unwrap()))
        .await
        .unwrap();
    assert_eq!(stored.state, "pending");
    assert_eq!(stored.attempts, 1);
    assert_eq!(remote.moved.len(), 1);
    assert!(remote.selected.iter().all(|folder| folder == "INBOX"));
}

#[tokio::test]
async fn invalid_identity_or_missing_target_never_mutates_remote() {
    for overrides in [
        json!({"srcMessageId": "<>"}),
        json!({"srcMessageId": "a\r\nUID MOVE 9 Trash"}),
        json!({"srcMessageId": "x".repeat(999)}),
        json!({"srcMessageId": 42}),
        json!({"srcFolderId": null}),
        json!({"targetFolderId": null}),
        json!({"targetFolderId": 1}),
    ] {
        let fixture = fixture(overrides).await;
        let mut remote = FakeRemote::new(&fixture);
        assert!(matches!(
            move_action(&fixture.ctx, &mut remote, &fixture.action).await,
            Err(CoreError::ActionRejected(_))
        ));
        assert!(remote.selected.is_empty());
        assert!(remote.moved.is_empty());
    }
}

#[tokio::test]
async fn action_losing_claim_cannot_mutate_or_emit_a_fake_pending_state() {
    let fixture = fixture(json!({})).await;
    let id = fixture.action.id;
    fixture
        .ctx
        .db
        .write(move |conn| repo::actions::set_state(conn, id, "cancelled", None))
        .await
        .unwrap();
    let mut events = fixture.ctx.bus.subscribe();
    let mut remote = FakeRemote::new(&fixture);
    let outcome = move_action(&fixture.ctx, &mut remote, &fixture.action).await;
    assert!(matches!(outcome, Err(CoreError::ActionDeferred(_))));
    assert!(remote.moved.is_empty());
    record_outcomes(&fixture.ctx, &[fixture.action], &outcome)
        .await
        .unwrap();
    let stored = fixture
        .ctx
        .db
        .read(move |conn| Ok(repo::actions::get(conn, id)?.unwrap()))
        .await
        .unwrap();
    assert_eq!(stored.state, "cancelled");
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn destination_uid_is_adopted_only_for_unresolved_target() {
    let fixture = fixture(json!({"srcUid":7,"srcUidValidity":9})).await;
    let message = fixture.message_id;
    fixture
        .ctx
        .db
        .write(move |conn| {
            conn.execute("UPDATE messages SET uid=NULL WHERE id=?1", [message])?;
            Ok(())
        })
        .await
        .unwrap();
    let mut remote = FakeRemote::new(&fixture);
    move_action(&fixture.ctx, &mut remote, &fixture.action)
        .await
        .unwrap();
    let row = fixture
        .ctx
        .db
        .read(move |conn| repo::messages::get_row(conn, message))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.uid, Some(501));
}

#[tokio::test]
async fn terminal_move_failure_restores_source_and_thread_folder() {
    let fixture = fixture(json!({"srcUid":7,"srcUidValidity":9})).await;
    record_outcomes(
        &fixture.ctx,
        std::slice::from_ref(&fixture.action),
        &Err(CoreError::ActionRejected("NO rejected".into())),
    )
    .await
    .unwrap();
    let message = fixture.message_id;
    fixture
        .ctx
        .db
        .read(move |conn| {
            let row = repo::messages::get_row(conn, message)?.unwrap();
            assert_eq!(row.folder_id, Some(1));
            assert_eq!(row.uid, Some(7));
            let count: i64 = conn.query_row(
                "SELECT message_count FROM threads WHERE id=?1",
                [row.thread_id.unwrap()],
                |r| r.get(0),
            )?;
            assert_eq!(count, 1);
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn expired_move_deferral_rolls_back_using_persisted_source() {
    let fixture = fixture(json!({"srcUid":7,"srcUidValidity":9,"deferrals":31})).await;
    record_outcomes(
        &fixture.ctx,
        std::slice::from_ref(&fixture.action),
        &Err(CoreError::ActionDeferred("waiting".into())),
    )
    .await
    .unwrap();
    let message = fixture.message_id;
    let action = fixture.action.id;
    fixture
        .ctx
        .db
        .read(move |conn| {
            assert_eq!(repo::actions::get(conn, action)?.unwrap().state, "failed");
            let row = repo::messages::get_row(conn, message)?.unwrap();
            assert_eq!((row.folder_id, row.uid), (Some(1), Some(7)));
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn missing_copyuid_searches_destination_and_keeps_ambiguous_uid_null() {
    for hits in [vec![61], vec![], vec![61, 62]] {
        let fixture = fixture(json!({"srcUid":7,"srcUidValidity":9})).await;
        let message = fixture.message_id;
        fixture
            .ctx
            .db
            .write(move |conn| {
                conn.execute("UPDATE messages SET uid=NULL WHERE id=?1", [message])?;
                Ok(())
            })
            .await
            .unwrap();
        let mut remote = FakeRemote::new(&fixture);
        remote.destination = None;
        remote.matches = hits.clone();
        move_action(&fixture.ctx, &mut remote, &fixture.action)
            .await
            .unwrap();
        assert_eq!(remote.selected, ["INBOX", "Trash"]);
        let row = fixture
            .ctx
            .db
            .read(move |conn| repo::messages::get_row(conn, message))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.uid, if hits.len() == 1 { Some(61) } else { None });
    }
}

#[tokio::test]
async fn changed_target_namespace_discards_unverified_copyuid_and_updates_epoch() {
    let fixture = fixture(json!({"srcUid":7,"srcUidValidity":9})).await;
    fixture
        .ctx
        .db
        .write(|conn| {
            conn.execute("UPDATE folders SET uidvalidity=8 WHERE id=2", [])?;
            Ok(())
        })
        .await
        .unwrap();
    let mut remote = FakeRemote::new(&fixture);
    remote.verified = false;
    remote.matches = vec![61];
    move_action(&fixture.ctx, &mut remote, &fixture.action)
        .await
        .unwrap();
    let message = fixture.message_id;
    fixture
        .ctx
        .db
        .read(move |conn| {
            assert_eq!(repo::folders::get(conn, 2)?.unwrap().uidvalidity, Some(9));
            assert_eq!(
                repo::messages::get_row(conn, message)?.unwrap().uid,
                Some(61)
            );
            Ok(())
        })
        .await
        .unwrap();
}
