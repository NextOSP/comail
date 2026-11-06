//! Disposable loopback Dovecot only; never uses a user's database or credentials.
use comail_core::{
    Core, config::Paths, db::repo, imap, models::*, oauth::tokens::TokenProvider, queue,
    sync::engine::SyncCtx,
};
use serde_json::{Value, json};
use std::sync::Arc;

async fn mcp(http: &reqwest::Client, url: &str, token: &str, name: &str, args: Value) -> Value {
    let text = http.post(url).bearer_auth(token)
        .header("accept", "application/json, text/event-stream")
        .header("content-type", "application/json")
        .body(json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}).to_string())
        .send().await.unwrap().text().await.unwrap();
    let result: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(result["result"]["isError"], false, "{result}");
    serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

fn action(kind: ActionKind, thread_id: i64) -> PerformActionArgs {
    PerformActionArgs {
        kind,
        thread_ids: vec![thread_id],
        params: None,
    }
}

#[tokio::test]
#[ignore = "requires disposable Dovecot at ports 11993 and 12993, COMAIL_TLS_INSECURE=1"]
async fn shared_action_and_mcp_delete_with_remote_confirmation_and_safety_guards() {
    assert!(imap::tls_insecure());
    let root = tempfile::tempdir().unwrap();
    // Set before Core starts, and only within this standalone test executable.
    unsafe {
        std::env::set_var(
            "COMAIL_CREDENTIALS_INSECURE_FILE",
            root.path().join("creds.json"),
        );
    }
    for (port, supported) in [(11993, true), (12993, false)] {
        let paths = Paths::for_tests(&root.path().join(port.to_string()));
        let core = Core::start(paths.clone()).await.unwrap();
        let username = format!("permanentdeletee2e{}", rand::random::<u128>());
        let mut session = imap::connect(
            "127.0.0.1",
            port,
            imap::ImapCredentials::Password {
                user: username.clone(),
                password: "pass".into(),
            },
        )
        .await
        .unwrap();
        let trash = "Trash".to_string();
        let inbox = "DeleteE2E-Inbox".to_string();
        let alternate = "Deleted Items".to_string();
        for folder in [&trash, &inbox, &alternate] {
            imap::create_folder(&mut session, folder).await.unwrap();
        }
        let remote_trash = imap::list_folders(&mut session)
            .await
            .unwrap()
            .into_iter()
            .find(|folder| folder.name == trash)
            .unwrap();
        let detected =
            comail_core::sync::folder_map::detect_role_with_source(&remote_trash).unwrap();
        assert_eq!(detected.role, roles::TRASH);
        assert_eq!(detected.source, repo::folders::RoleSource::SpecialUse);
        for i in 1..=4 {
            let raw = format!(
                "Message-ID: <{trash}-{i}@example.invalid>\r\nFrom: sender@example.invalid\r\nTo: test@example.invalid\r\nSubject: Delete test\r\n\r\nSynthetic {i}\r\n"
            );
            imap::append(
                &mut session,
                if i == 4 { &inbox } else { &trash },
                raw.as_bytes(),
                false,
            )
            .await
            .unwrap();
        }
        let selected = imap::select(&mut session, &trash).await.unwrap();
        let validity = selected.uid_validity.unwrap();
        let mut uids = imap::uid_search_all(&mut session).await.unwrap();
        uids.sort_unstable();
        assert_eq!(uids.len(), 3);
        // An unrelated message flagged Deleted must survive targeted expunge.
        imap::store_flag(&mut session, uids[2], "\\Deleted", true)
            .await
            .unwrap();
        let inbox_validity = imap::select(&mut session, &inbox)
            .await
            .unwrap()
            .uid_validity
            .unwrap();
        let alternate_validity = imap::select(&mut session, &alternate)
            .await
            .unwrap()
            .uid_validity
            .unwrap();
        let names = (trash.clone(), inbox.clone(), alternate.clone());
        let saved_uids = uids.clone();
        core.db.write(move |conn| {
            conn.execute("INSERT INTO accounts (id,email,provider,auth_kind,username,imap_host,imap_port,smtp_host,smtp_port,created_at)
                VALUES (1,'test@example.invalid','imap','password',?2,'127.0.0.1',?1,'127.0.0.1',10587,0)", rusqlite::params![port,username])?;
            conn.execute("INSERT INTO folders (id,account_id,imap_name,role,role_source,uidvalidity) VALUES (1,1,?1,'inbox','inbox',?2),(2,1,?3,'trash','special_use',?4),(3,1,?5,'trash','name',?6)", rusqlite::params![names.1,inbox_validity,names.0,validity,names.2,alternate_validity])?;
            assert_eq!(repo::folders::by_role(conn, 1, roles::TRASH)?.unwrap().id, 2);
            for (i, uid) in saved_uids.iter().enumerate() {
                let id = (i+1) as i64;
                conn.execute("INSERT INTO threads (id,account_id,subject_norm,last_message_at) VALUES (?1,1,'test',1000)", [id])?;
                conn.execute("INSERT INTO messages (id,thread_id,account_id,folder_id,uid,message_id,subject,date,is_read) VALUES (?1,?1,1,2,?2,?3,'test',1000,0)", rusqlite::params![id,uid,format!("{}-{id}@example.invalid",names.0)])?;
            }
            conn.execute("INSERT INTO messages (id,thread_id,account_id,folder_id,uid,message_id,subject,date,is_read) VALUES (4,1,1,1,1,?1,'test',1000,0)", [format!("{}-4@example.invalid",names.0)])?;
            for id in 1..=3 { repo::threads::recompute(conn, id)?; }
            Ok(())
        }).await.unwrap();
        let ctx = SyncCtx {
            db: core.db.clone(),
            bus: core.bus.clone(),
            paths: Arc::new(paths),
            tokens: TokenProvider::new(),
        };
        let config = core
            .db
            .read(|c| Ok(repo::accounts::get_config(c, 1)?.unwrap()))
            .await
            .unwrap();
        let result = core
            .perform_action(action(ActionKind::DeletePermanently, 1))
            .await
            .unwrap();
        assert_eq!(
            core.perform_action(action(ActionKind::DeletePermanently, 1))
                .await
                .unwrap()
                .action_ids,
            result.action_ids
        );
        assert_eq!(core.get_thread(1).await.unwrap().messages.len(), 1);
        assert!(
            core.db
                .read(|c| repo::messages::get_row(c, 1))
                .await
                .unwrap()
                .is_some()
        );
        imap::select(&mut session, &trash).await.unwrap();
        queue::execute_due(&ctx, &config, &mut session)
            .await
            .unwrap();
        let status = core.deletion_status(result.action_ids).await.unwrap();
        if !supported {
            assert_eq!(status[0].state, "failed");
            assert!(status[0].error.as_deref().unwrap().contains("UIDPLUS"));
            assert_eq!(imap::uid_search_all(&mut session).await.unwrap().len(), 3);
            assert_eq!(session.uid_search("DELETED").await.unwrap().len(), 1);
            assert!(
                core.db
                    .read(|c| repo::messages::get_row(c, 1))
                    .await
                    .unwrap()
                    .is_some()
            );
            imap::logout(session).await;
            continue;
        }
        assert_eq!(status[0].state, "done");
        assert!(
            core.db
                .read(|c| repo::messages::get_row(c, 1))
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            core.db
                .read(|c| repo::messages::get_row(c, 4))
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(imap::uid_search_all(&mut session).await.unwrap().len(), 2);
        imap::select(&mut session, &inbox).await.unwrap();
        assert_eq!(imap::uid_search_all(&mut session).await.unwrap().len(), 1);

        // UIDVALIDITY mismatch is a terminal preflight failure, before STORE.
        core.db
            .write(move |c| {
                c.execute(
                    "UPDATE folders SET uidvalidity=?1 WHERE id=2",
                    [validity + 1],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let stale = core
            .perform_action(action(ActionKind::DeletePermanently, 3))
            .await
            .unwrap();
        queue::execute_due(&ctx, &config, &mut session)
            .await
            .unwrap();
        assert_eq!(
            core.deletion_status(stale.action_ids).await.unwrap()[0].state,
            "failed"
        );
        assert_eq!(imap::uid_search_all(&mut session).await.unwrap().len(), 2);
        // Reproduce a real server-side purge, leaving its UID-less local row.
        let purged_message_id = format!("purged-{trash}@example.invalid");
        let raw = format!(
            "Message-ID: <{purged_message_id}>\r\nFrom: sender@example.invalid\r\nSubject: Purged\r\n\r\nSynthetic purge fixture\r\n"
        );
        imap::append(&mut session, &trash, raw.as_bytes(), false)
            .await
            .unwrap();
        imap::select(&mut session, &trash).await.unwrap();
        let purged_uids = session
            .uid_search(format!("HEADER Message-ID \"{purged_message_id}\""))
            .await
            .unwrap()
            .into_iter()
            .collect::<Vec<_>>();
        assert_eq!(purged_uids.len(), 1);
        imap::prepare_uid_delete(&mut session, &purged_uids)
            .await
            .unwrap()
            .execute(&mut session)
            .await
            .unwrap();
        core.db
            .write(move |c| {
                c.execute("UPDATE folders SET uidvalidity=?1 WHERE id=2", [validity])?;
                c.execute("UPDATE messages SET uid=NULL WHERE id=2", [])?;
                c.execute("INSERT INTO threads(id,account_id,subject_norm,last_message_at) VALUES(5,1,'purged ghost',1000)", [])?;
                c.execute("INSERT INTO messages(id,thread_id,account_id,folder_id,uid,message_id,subject,date) VALUES(5,5,1,2,NULL,?1,'purged ghost',1000)", [purged_message_id])?;
                repo::threads::recompute(c, 5)?;
                Ok(())
            })
            .await
            .unwrap();

        // UID-less deletion uses the same ordered path over authenticated MCP.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let mcp_port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut settings = core.get_settings().await.unwrap();
        settings.mcp_enabled = true;
        settings.mcp_allow_actions = true;
        settings.mcp_allow_permanent_delete = true;
        settings.mcp_port = mcp_port;
        core.set_settings(settings).await.unwrap();
        let url = core.mcp_status().await.unwrap().url;
        let token = core.mcp_token().await.unwrap();
        let http = reqwest::Client::new();
        let out = mcp(
            &http,
            &url,
            &token,
            "modify_threads",
            json!({"action":"delete_permanently","thread_ids":[2,5]}),
        )
        .await;
        assert_eq!(out["status"], "queued");
        let mut deletion_events = core.bus.subscribe();
        queue::execute_due(&ctx, &config, &mut session)
            .await
            .unwrap();
        let statuses = mcp(
            &http,
            &url,
            &token,
            "deletion_status",
            json!({"action_ids":out["action_ids"]}),
        )
        .await;
        assert_eq!(statuses[0]["state"], "done");
        assert_eq!(
            statuses[1]["state"], "done",
            "a complete listing proves the purge"
        );
        let purged_action = out["action_ids"][1].as_i64().unwrap();
        let mut success_event = false;
        while let Ok(event) = deletion_events.try_recv() {
            if let comail_core::events::CoreEvent::ActionState {
                action_id, state, ..
            } = event
            {
                success_event |= action_id == purged_action && state == "done";
            }
        }
        assert!(
            success_event,
            "already-purged deletion emits success, not retry exhaustion"
        );
        assert!(
            core.db
                .read(|c| repo::messages::get_row(c, 5))
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            core.db
                .read(|c| repo::messages::get_row(c, 2))
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            imap::uid_search_all(&mut session).await.unwrap(),
            vec![uids[2]]
        );
        assert_eq!(session.uid_search("DELETED").await.unwrap().len(), 1);

        // The old deadlock: enqueue read, trash and delete before executing any.
        core.perform_action(action(ActionKind::MarkRead, 1))
            .await
            .unwrap();
        core.perform_action(action(ActionKind::Trash, 1))
            .await
            .unwrap();
        let deletion = core
            .perform_action(action(ActionKind::DeletePermanently, 1))
            .await
            .unwrap();
        // Advance the ordinary undo window in this synthetic fixture only.
        core.db
            .write(|c| {
                c.execute(
                    "UPDATE pending_actions SET not_before=NULL WHERE state='pending'",
                    [],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        for _ in 0..4 {
            queue::execute_due(&ctx, &config, &mut session)
                .await
                .unwrap();
        }
        let pending = core.db.read(|c| {
            let mut s = c.prepare("SELECT id,kind,state,last_error,payload FROM pending_actions WHERE state IN ('pending','inflight')")?;
            Ok(s.query_map([], |r| Ok(format!("{} {} {} {:?} {}", r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, String>(4)?)))?.collect::<rusqlite::Result<Vec<_>>>()?)
        }).await.unwrap();
        assert_eq!(
            core.deletion_status(deletion.action_ids).await.unwrap()[0].state,
            "done",
            "{pending:?}"
        );
        assert!(
            core.db
                .read(|c| repo::messages::get_row(c, 4))
                .await
                .unwrap()
                .is_none()
        );
        imap::select(&mut session, &inbox).await.unwrap();
        assert!(imap::uid_search_all(&mut session).await.unwrap().is_empty());
        imap::select(&mut session, &trash).await.unwrap();
        assert_eq!(
            imap::uid_search_all(&mut session).await.unwrap(),
            vec![uids[2]]
        );
        // A legacy name-only Trash role must route through canonical server Trash.
        for i in 6..=7 {
            let raw = format!(
                "Message-ID: <{trash}-{i}@example.invalid>\r\nFrom: sender@example.invalid\r\nSubject: Alternate Trash\r\n\r\nSynthetic alternate {i}\r\n"
            );
            imap::append(&mut session, &alternate, raw.as_bytes(), false)
                .await
                .unwrap();
        }
        imap::select(&mut session, &alternate).await.unwrap();
        let mut alternate_uids = imap::uid_search_all(&mut session).await.unwrap();
        alternate_uids.sort_unstable();
        assert_eq!(alternate_uids.len(), 2);
        imap::store_flag(&mut session, alternate_uids[1], "\\Deleted", true)
            .await
            .unwrap();
        let alternate_uid = alternate_uids[0];
        let alternate_message_id = format!("{trash}-6@example.invalid");
        core.db.write(move |c| {
            c.execute("INSERT INTO threads(id,account_id,subject_norm,last_message_at) VALUES(6,1,'alternate trash',1000)", [])?;
            c.execute("INSERT INTO messages(id,thread_id,account_id,folder_id,uid,message_id,subject,date) VALUES(6,6,1,3,?1,?2,'alternate trash',1000)", rusqlite::params![alternate_uid,alternate_message_id])?;
            repo::threads::recompute(c, 6)?;
            Ok(())
        }).await.unwrap();
        let alternate_deletion = core
            .perform_action(action(ActionKind::DeletePermanently, 6))
            .await
            .unwrap();
        assert_eq!(alternate_deletion.action_ids.len(), 1);
        let delete_id = alternate_deletion.action_ids[0];
        let move_id = core.db.write(move |c| {
            let actions = {
                let mut stmt = c.prepare("SELECT id,kind,payload FROM pending_actions WHERE message_id=6 ORDER BY id")?;
                stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            assert_eq!(actions.len(), 2, "one canonical move precedes the delete");
            assert_eq!(actions[0].1, "trash");
            assert_eq!(actions[1].1, "delete_permanently");
            assert_eq!(actions[1].0, delete_id, "returned IDs exclude inserted moves");
            assert!(actions[0].0 < delete_id);
            let payload: Value = serde_json::from_str(&actions[0].2)?;
            assert_eq!(payload["srcFolderId"], 3);
            assert_eq!(payload["targetFolderId"], 2);
            c.execute("UPDATE pending_actions SET not_before=NULL WHERE message_id=6 AND state='pending'", [])?;
            Ok(actions[0].0)
        }).await.unwrap();
        assert!(matches!(
            core.get_thread(6).await,
            Err(comail_core::error::CoreError::NotFound(_))
        ));
        assert!(
            core.db
                .read(|c| repo::messages::get_row(c, 6))
                .await
                .unwrap()
                .is_some()
        );
        queue::execute_due(&ctx, &config, &mut session)
            .await
            .unwrap();
        let move_state = core
            .db
            .read(move |c| Ok(repo::actions::get(c, move_id)?.unwrap().state))
            .await
            .unwrap();
        assert_eq!(move_state, "done");
        assert_eq!(
            core.deletion_status(vec![delete_id]).await.unwrap()[0].state,
            "pending"
        );
        imap::select(&mut session, &alternate).await.unwrap();
        assert_eq!(
            imap::uid_search_all(&mut session).await.unwrap(),
            vec![alternate_uids[1]]
        );
        assert_eq!(session.uid_search("DELETED").await.unwrap().len(), 1);
        imap::select(&mut session, &trash).await.unwrap();
        assert_eq!(
            imap::uid_search_all(&mut session).await.unwrap().len(),
            2,
            "target reaches canonical Trash before deletion"
        );
        queue::execute_due(&ctx, &config, &mut session)
            .await
            .unwrap();
        assert_eq!(
            core.deletion_status(vec![delete_id]).await.unwrap()[0].state,
            "done"
        );
        assert!(
            core.db
                .read(|c| repo::messages::get_row(c, 6))
                .await
                .unwrap()
                .is_none()
        );
        imap::select(&mut session, &trash).await.unwrap();
        assert_eq!(
            imap::uid_search_all(&mut session).await.unwrap(),
            vec![uids[2]]
        );
        assert_eq!(session.uid_search("DELETED").await.unwrap().len(), 1);
        imap::select(&mut session, &alternate).await.unwrap();
        assert_eq!(
            imap::uid_search_all(&mut session).await.unwrap(),
            vec![alternate_uids[1]]
        );
        assert_eq!(session.uid_search("DELETED").await.unwrap().len(), 1);

        // A terminal canonical-move rollback must not become "already absent" success.
        let rollback_message_id = format!("{trash}-8@example.invalid");
        let raw = format!(
            "Message-ID: <{rollback_message_id}>\r\nFrom: sender@example.invalid\r\nSubject: Move rollback\r\n\r\nSynthetic rollback fixture\r\n"
        );
        imap::append(&mut session, &alternate, raw.as_bytes(), false)
            .await
            .unwrap();
        imap::select(&mut session, &alternate).await.unwrap();
        let rollback_uids = session
            .uid_search(format!("HEADER Message-ID \"{rollback_message_id}\""))
            .await
            .unwrap()
            .into_iter()
            .collect::<Vec<_>>();
        assert_eq!(rollback_uids.len(), 1);
        let rollback_uid = rollback_uids[0];
        core.db.write(move |c| {
            c.execute("INSERT INTO threads(id,account_id,subject_norm,last_message_at) VALUES(8,1,'move rollback',1000)", [])?;
            c.execute("INSERT INTO messages(id,thread_id,account_id,folder_id,uid,message_id,subject,date) VALUES(8,8,1,3,?1,?2,'move rollback',1000)", rusqlite::params![rollback_uid,rollback_message_id])?;
            repo::threads::recompute(c, 8)?;
            Ok(())
        }).await.unwrap();
        let rollback_deletion = core
            .perform_action(action(ActionKind::DeletePermanently, 8))
            .await
            .unwrap();
        assert_eq!(rollback_deletion.action_ids.len(), 1);
        let rollback_delete_id = rollback_deletion.action_ids[0];
        assert!(matches!(
            core.get_thread(8).await,
            Err(comail_core::error::CoreError::NotFound(_))
        ));
        core.db
            .write(move |c| {
                let tx = c.transaction()?;
                let move_action = tx.query_row(
                    "SELECT id FROM pending_actions WHERE message_id=8 AND kind='trash' AND id<?1",
                    [rollback_delete_id],
                    |r| r.get::<_, i64>(0),
                )?;
                assert_eq!(repo::messages::get_row(&tx, 8)?.unwrap().folder_id, Some(2));
                // Emulate the queue's terminal move failure without touching the server.
                repo::actions::set_state(
                    &tx,
                    move_action,
                    "failed",
                    Some("synthetic terminal move failure"),
                )?;
                tx.execute(
                    "UPDATE messages SET folder_id=3,uid=?1 WHERE id=8",
                    [rollback_uid],
                )?;
                repo::threads::recompute(&tx, 8)?;
                tx.commit()?;
                Ok(())
            })
            .await
            .unwrap();
        queue::execute_due(&ctx, &config, &mut session)
            .await
            .unwrap();
        let rollback_status = core
            .deletion_status(vec![rollback_delete_id])
            .await
            .unwrap();
        assert_eq!(rollback_status[0].state, "failed");
        assert!(
            rollback_status[0]
                .error
                .as_deref()
                .unwrap()
                .contains("not in canonical Trash")
        );
        let restored = core.get_thread(8).await.unwrap();
        assert_eq!(
            restored.messages.len(),
            1,
            "failed delete restores visibility"
        );
        let row = core
            .db
            .read(|c| repo::messages::get_row(c, 8))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.folder_id, Some(3));
        assert_eq!(row.uid, Some(i64::from(rollback_uid)));
        imap::select(&mut session, &alternate).await.unwrap();
        let mut remaining = imap::uid_search_all(&mut session).await.unwrap();
        remaining.sort_unstable();
        assert_eq!(remaining, vec![alternate_uids[1], rollback_uid]);
        assert_eq!(
            session
                .uid_search("DELETED")
                .await
                .unwrap()
                .into_iter()
                .collect::<Vec<_>>(),
            vec![alternate_uids[1]],
            "neither STORE Deleted nor expunge touched the restored source"
        );
        imap::select(&mut session, &trash).await.unwrap();
        assert_eq!(
            imap::uid_search_all(&mut session).await.unwrap(),
            vec![uids[2]]
        );
        assert_eq!(session.uid_search("DELETED").await.unwrap().len(), 1);

        let mut settings = core.get_settings().await.unwrap();
        settings.mcp_enabled = false;
        core.set_settings(settings).await.unwrap();
        imap::logout(session).await;
    }
}
