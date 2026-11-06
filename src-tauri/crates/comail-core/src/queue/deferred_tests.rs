use super::*;

#[tokio::test]
async fn bounded_deferrals_release_chain_without_consuming_remote_attempts() {
    let root = tempfile::tempdir().unwrap();
    let paths = crate::config::Paths::for_tests(root.path());
    let db = crate::db::Db::open(&paths.db_file()).unwrap();
    let (action_id, chained_id, independent_id) = db
        .write(|conn| {
            crate::db::testutil::seed_account(conn);
            let (thread_id, message_id) =
                crate::db::testutil::seed_message(conn, "sender@test.dev", "waiting", false);
            let payload = serde_json::json!({});
            let action_id = repo::actions::enqueue(
                conn,
                1,
                "trash",
                Some(message_id),
                Some(thread_id),
                &payload,
                None,
            )?;
            conn.execute(
                "UPDATE pending_actions SET attempts = ?2 WHERE id = ?1",
                rusqlite::params![action_id, MAX_ATTEMPTS + 2],
            )?;
            // A chained action must wait, but a separate message must remain due.
            let chained_id = repo::actions::enqueue(
                conn,
                1,
                "move",
                Some(message_id),
                Some(thread_id),
                &payload,
                None,
            )?;
            let independent_id =
                repo::actions::enqueue(conn, 1, "star", None, None, &payload, None)?;
            Ok((action_id, chained_id, independent_id))
        })
        .await
        .unwrap();
    let ctx = SyncCtx {
        db,
        bus: crate::events::EventBus::new(),
        paths: std::sync::Arc::new(paths),
        tokens: crate::oauth::tokens::TokenProvider::new(),
    };
    let mut events = ctx.bus.subscribe();
    let mut first_deferred_at = None;
    for deferrals in 1..=MAX_DEFERRALS {
        let action = ctx
            .db
            .write(move |conn| {
                assert!(repo::actions::try_claim(conn, action_id)?);
                Ok(repo::actions::get(conn, action_id)?.unwrap())
            })
            .await
            .unwrap();
        let error = CoreError::ActionDeferred(
            "NO 550 bad connection closed: still waiting for identity".into(),
        );
        assert!(!terminal_failure("trash", action.attempts + 1, &error));
        assert!(!needs_fresh_session(&error));
        record_outcomes(&ctx, &[action], &Err(error)).await.unwrap();
        let (stored, due) = ctx
            .db
            .read(move |conn| {
                Ok((
                    repo::actions::get(conn, action_id)?.unwrap(),
                    repo::actions::due(conn, 1, now_ms(), 20)?,
                ))
            })
            .await
            .unwrap();
        let expected = if deferrals == MAX_DEFERRALS {
            "failed"
        } else {
            "pending"
        };
        assert_eq!(stored.state, expected);
        assert_eq!(stored.attempts, MAX_ATTEMPTS + 2);
        assert_eq!(stored.payload["deferrals"], deferrals);
        let first = stored.payload["firstDeferredAt"].as_i64().unwrap();
        assert_eq!(*first_deferred_at.get_or_insert(first), first);
        if expected == "pending" {
            assert!(stored.not_before.unwrap() > now_ms());
            assert_eq!(
                due.iter().map(|action| action.id).collect::<Vec<_>>(),
                [independent_id]
            );
        } else {
            assert!(stored.not_before.is_none());
            assert_eq!(
                due.iter().map(|action| action.id).collect::<Vec<_>>(),
                [chained_id, independent_id]
            );
        }
        match events.try_recv().unwrap() {
            CoreEvent::ActionState {
                state,
                error: Some(error),
                ..
            } => {
                assert_eq!(state, expected);
                if state == "failed" {
                    assert!(error.contains(DEFERRAL_EXHAUSTED));
                }
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }
}

#[test]
fn deferral_counter_backoff_and_source_identity_survive_database_reopen() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("deferrals.sqlite");
    let mut conn = rusqlite::Connection::open(&path).unwrap();
    crate::db::migrations::run(&mut conn).unwrap();
    crate::db::testutil::seed_account(&conn);
    let identity = serde_json::json!({
        "srcFolderId": 1, "targetFolderId": 2, "srcUid": 41,
        "srcUidValidity": 9, "srcMessageId": "source@test.dev", "extra": {"preserve": true}
    });
    let id = repo::actions::enqueue(&conn, 1, "move", None, None, &identity, None).unwrap();
    conn.execute(
        "UPDATE pending_actions SET attempts = 3 WHERE id = ?1",
        [id],
    )
    .unwrap();
    drop(conn);
    let first = 100_000_000_i64;
    let mut now = first;
    for (index, delay) in [
        5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 900_000, 900_000,
    ]
    .into_iter()
    .enumerate()
    {
        let mut conn = rusqlite::Connection::open(&path).unwrap();
        assert!(repo::actions::try_claim(&conn, id).unwrap());
        let (state, _) = record_deferral(&mut conn, id, now, "source absent")
            .unwrap()
            .unwrap();
        assert_eq!(state, "pending");
        drop(conn);
        let conn = rusqlite::Connection::open(&path).unwrap();
        let stored = repo::actions::get(&conn, id).unwrap().unwrap();
        assert_eq!(stored.payload["deferrals"], index + 1);
        assert_eq!(stored.payload["firstDeferredAt"], first);
        assert_eq!(stored.not_before, Some(now + delay));
        assert_eq!(stored.attempts, 3);
        for (key, value) in identity.as_object().unwrap() {
            assert_eq!(&stored.payload[key], value);
        }
        now += delay;
    }
}

#[test]
fn elapsed_deadline_survives_reload_and_clamps_last_retry() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("deadline.sqlite");
    let mut conn = rusqlite::Connection::open(&path).unwrap();
    crate::db::migrations::run(&mut conn).unwrap();
    crate::db::testutil::seed_account(&conn);
    let id =
        repo::actions::enqueue(&conn, 1, "move", None, None, &serde_json::json!({}), None).unwrap();
    let first = 100_000_000_i64;
    assert!(repo::actions::try_claim(&conn, id).unwrap());
    record_deferral(&mut conn, id, first, "source absent").unwrap();
    drop(conn);
    let mut conn = rusqlite::Connection::open(&path).unwrap();
    assert!(repo::actions::try_claim(&conn, id).unwrap());
    let deadline = first + MAX_DEFERRAL_AGE_MS;
    record_deferral(&mut conn, id, deadline - 1_000, "still absent").unwrap();
    assert_eq!(
        repo::actions::get(&conn, id).unwrap().unwrap().not_before,
        Some(deadline)
    );
    drop(conn);
    let mut conn = rusqlite::Connection::open(&path).unwrap();
    assert!(repo::actions::try_claim(&conn, id).unwrap());
    let (state, error) = record_deferral(&mut conn, id, deadline, "lost acknowledgement")
        .unwrap()
        .unwrap();
    assert_eq!(state, "failed");
    assert!(error.contains(DEFERRAL_EXHAUSTED));
    assert!(error.contains("lost acknowledgement"));
    let stored = repo::actions::get(&conn, id).unwrap().unwrap();
    assert_eq!(stored.state, "failed");
    assert_eq!(stored.attempts, 0);
    assert_eq!(stored.payload["deferrals"], 3);
    assert_eq!(stored.payload["firstDeferredAt"], first);
    assert!(stored.not_before.is_none());
    let finished_at: i64 = conn
        .query_row(
            "SELECT finished_at FROM pending_actions WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(finished_at, deadline);
}

#[test]
fn already_exceeded_deferral_counter_fails_without_resetting_identity() {
    let mut conn = crate::db::testutil::conn();
    crate::db::testutil::seed_account(&conn);
    for count in [31, 32, 100] {
        let id = repo::actions::enqueue(
            &conn,
            1,
            "move",
            None,
            None,
            &serde_json::json!({"deferrals": count, "firstDeferredAt": 1_000, "srcUid": 77}),
            None,
        )
        .unwrap();
        assert!(repo::actions::try_claim(&conn, id).unwrap());
        assert_eq!(
            record_deferral(&mut conn, id, 2_000, "ambiguous")
                .unwrap()
                .unwrap()
                .0,
            "failed"
        );
        let stored = repo::actions::get(&conn, id).unwrap().unwrap();
        assert_eq!(stored.payload["deferrals"], count + 1);
        assert_eq!(stored.payload["firstDeferredAt"], 1_000);
        assert_eq!(stored.payload["srcUid"], 77);
        assert_eq!(stored.state, "failed");
        assert_eq!(stored.attempts, 0);
    }
}

#[test]
fn typed_action_errors_have_stable_codes_and_do_not_use_string_heuristics() {
    let deferred = CoreError::ActionDeferred("NO bad connection 550".into());
    let rejected =
        CoreError::ActionRejected("connection identity belongs to another account".into());
    assert_eq!(deferred.code(), "action_deferred");
    assert_eq!(rejected.code(), "action_rejected");
    assert!(!terminal_failure("move", MAX_ATTEMPTS + 1, &deferred));
    assert!(terminal_failure("move", 0, &rejected));
    assert!(!needs_fresh_session(&deferred));
    assert!(!needs_fresh_session(&rejected));
}

#[test]
fn missing_local_uid_defers_instead_of_completing() {
    assert!(matches!(
        local_remote_location(1, Some(2), None),
        Err(CoreError::ActionDeferred(_))
    ));
    assert!(matches!(
        local_remote_location(1, None, Some(3)),
        Err(CoreError::ActionDeferred(_))
    ));
    assert_eq!(local_remote_location(1, Some(2), Some(3)).unwrap(), (2, 3));
}
