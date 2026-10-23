use super::*;

#[test]
fn post_move_retry_waits_for_grace_without_spending_the_attempt_budget() {
    for kind in ["move", "trash"] {
        let mut conn = crate::db::testutil::conn();
        crate::db::testutil::seed_account(&conn);
        let (thread_id, message_id) =
            crate::db::testutil::seed_message(&conn, "sender@test.dev", "move grace", false);
        let now = now_ms();
        let moved = repo::actions::enqueue(
            &conn,
            1,
            kind,
            Some(message_id),
            Some(thread_id),
            &serde_json::json!({}),
            None,
        )
        .unwrap();
        repo::actions::set_state(&conn, moved, "done", None).unwrap();
        conn.execute(
            "UPDATE pending_actions SET finished_at=?2 WHERE id=?1",
            rusqlite::params![moved, now],
        )
        .unwrap();
        let id = repo::actions::enqueue(
            &conn,
            1,
            crate::trash::KIND,
            Some(message_id),
            Some(thread_id),
            &serde_json::json!({}),
            None,
        )
        .unwrap();
        assert!(repo::actions::try_claim(&conn, id).unwrap());
        let outcome = record_delete_failure(
            &mut conn,
            id,
            now,
            "Trash move is still settling before absence can be confirmed",
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(outcome.0, "pending");
        let stored = repo::actions::get(&conn, id).unwrap().unwrap();
        assert_eq!(stored.attempts, 1);
        assert_eq!(stored.not_before, Some(now + 5 * 60_000));
        assert!(
            repo::actions::due(&conn, 1, now + 5 * 60_000 - 1, 20)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            repo::actions::due(&conn, 1, now + 5 * 60_000, 20).unwrap()[0].id,
            id
        );
        assert_eq!(
            crate::trash::reconcile::completed_move_retry_at(&conn, message_id, now + 5 * 60_000)
                .unwrap(),
            None
        );
    }
}

#[test]
fn repeated_auth_pauses_preserve_attempts_and_exclude_paused_age() {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&mut conn).unwrap();
    crate::db::testutil::seed_account(&conn);
    let start = now_ms();
    let id = repo::actions::enqueue(
        &conn,
        1,
        crate::trash::KIND,
        None,
        None,
        &serde_json::json!({"remoteAttempted": true}),
        None,
    )
    .unwrap();
    conn.execute(
        "UPDATE pending_actions SET created_at=?2 WHERE id=?1",
        rusqlite::params![id, start],
    )
    .unwrap();
    for offset in [0, MAX_DELETE_AGE_MS, MAX_DELETE_AGE_MS * 3] {
        assert!(repo::actions::try_claim(&conn, id).unwrap());
        let result =
            record_delete_auth_pause(&mut conn, id, start + offset, "authentication required")
                .unwrap()
                .unwrap();
        assert_eq!(result.0, "paused");
        let stored = repo::actions::get(&conn, id).unwrap().unwrap();
        assert_eq!(stored.state, "pending");
        assert_eq!(stored.attempts, 0);
        assert_eq!(stored.payload["deleteAuthPausedAt"], start);
        assert_eq!(stored.not_before, Some(start + offset + 60_000));
    }
    // The pause survives reload/restart and an elapsed wall-clock age >24h.
    let resumed_at = start + MAX_DELETE_AGE_MS * 4;
    assert!(repo::actions::try_claim(&conn, id).unwrap());
    assert_eq!(
        resume_delete_budget(&conn, id, resumed_at).unwrap(),
        MAX_DELETE_AGE_MS * 4
    );
    assert_eq!(
        resume_delete_budget(&conn, id, resumed_at).unwrap(),
        MAX_DELETE_AGE_MS * 4
    );
    let result =
        record_delete_failure(&mut conn, id, resumed_at + 1000, "transport failure", false)
            .unwrap()
            .unwrap();
    assert_eq!(result.0, "pending");
    let stored = repo::actions::get(&conn, id).unwrap().unwrap();
    assert_eq!(stored.attempts, 1);
    assert!(stored.payload["deleteAuthPausedAt"].is_null());
    assert_eq!(stored.payload["remoteAttempted"], true);
    // Active time still expires after resumption, despite excluded pause time.
    assert!(repo::actions::try_claim(&conn, id).unwrap());
    let result = record_delete_failure(
        &mut conn,
        id,
        resumed_at + MAX_DELETE_AGE_MS,
        "verification deferred",
        false,
    )
    .unwrap()
    .unwrap();
    assert_eq!(result.0, "failed");
}

#[test]
fn auth_does_not_exhaust_an_already_aged_delete_or_increment_attempts() {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&mut conn).unwrap();
    crate::db::testutil::seed_account(&conn);
    let now = now_ms();
    let id = repo::actions::enqueue(
        &conn,
        1,
        crate::trash::KIND,
        None,
        None,
        &serde_json::json!({}),
        None,
    )
    .unwrap();
    conn.execute(
        "UPDATE pending_actions SET attempts=?2, created_at=?3 WHERE id=?1",
        rusqlite::params![id, MAX_ATTEMPTS, now - MAX_DELETE_AGE_MS * 2],
    )
    .unwrap();
    assert!(repo::actions::try_claim(&conn, id).unwrap());
    assert_eq!(
        record_delete_auth_pause(&mut conn, id, now, "auth rejected")
            .unwrap()
            .unwrap()
            .0,
        "paused"
    );
    let stored = repo::actions::get(&conn, id).unwrap().unwrap();
    assert_eq!(stored.attempts, MAX_ATTEMPTS);
    assert_eq!(stored.state, "pending");
}

#[tokio::test]
async fn delete_errors_release_visibility_and_thread_lock_at_attempt_or_age_limit() {
    for remote_attempted in [false, true] {
        for age_limit in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let paths = crate::config::Paths::for_tests(root.path());
            let db = crate::db::Db::open(&paths.db_file()).unwrap();
            let (id, thread_id, next_id) = db
                .write(move |conn| {
                    crate::db::testutil::seed_account(conn);
                    let (thread_id, message_id) = crate::db::testutil::seed_message(
                        conn,
                        "sender@test.dev",
                        "delete budget",
                        false,
                    );
                    let id = repo::actions::enqueue(
                        conn,
                        1,
                        crate::trash::KIND,
                        Some(message_id),
                        Some(thread_id),
                        &serde_json::json!({"remoteAttempted": remote_attempted}),
                        None,
                    )?;
                    conn.execute(
                        "UPDATE pending_actions SET attempts=?2, created_at=?3 WHERE id=?1",
                        rusqlite::params![
                            id,
                            if age_limit { 0 } else { MAX_ATTEMPTS - 1 },
                            if age_limit {
                                now_ms() - MAX_DELETE_AGE_MS
                            } else {
                                now_ms()
                            }
                        ],
                    )?;
                    let next_id = repo::actions::enqueue(
                        conn,
                        1,
                        "star",
                        Some(message_id),
                        Some(thread_id),
                        &serde_json::json!({}),
                        None,
                    )?;
                    assert!(repo::actions::try_claim(conn, id)?);
                    Ok((id, thread_id, next_id))
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
            let action = ctx
                .db
                .read(move |conn| Ok(repo::actions::get(conn, id)?.unwrap()))
                .await
                .unwrap();
            let error = if age_limit {
                CoreError::Network("connection closed".into())
            } else {
                CoreError::ActionDeferred("uncertain delete preflight".into())
            };
            record_outcomes(&ctx, &[action], &Err(error)).await.unwrap();
            ctx.db.read(move |conn| {
                let stored = repo::actions::get(conn, id)?.unwrap();
                assert_eq!(stored.state, "failed");
                let error: String = conn.query_row("SELECT last_error FROM pending_actions WHERE id=?1", [id], |r| r.get(0))?;
                assert!(error.contains("budget exhausted"));
                assert!(repo::actions::due(conn, 1, now_ms(), 20)?.iter().any(|a| a.id == next_id));
                let hidden: i64 = conn.query_row("SELECT count(*) FROM messages m WHERE m.thread_id=?1 AND EXISTS (SELECT 1 FROM pending_actions a WHERE a.message_id=m.id AND a.kind=?2 AND a.state IN ('pending','inflight'))", rusqlite::params![thread_id, crate::trash::KIND], |r| r.get(0))?;
                assert_eq!(hidden, 0);
                let count: i64 = conn.query_row("SELECT message_count FROM threads WHERE id=?1", [thread_id], |r| r.get(0))?;
                assert_eq!(count, 1);
                Ok(())
            }).await.unwrap();
            assert!(
                matches!(events.try_recv().unwrap(), CoreEvent::ActionState {state, error: Some(_), ..} if state == "failed")
            );
            assert!(
                matches!(events.try_recv().unwrap(), CoreEvent::MailUpdated {thread_ids} if thread_ids == [thread_id])
            );
        }
    }
}
