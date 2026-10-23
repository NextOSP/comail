//! Synthetic loopback Dovecot only; never connect to a configured real account.
use comail_core::{
    Core, config::Paths, db::repo, imap, models::*, oauth::tokens::TokenProvider, queue,
    sync::engine::SyncCtx,
};
use std::sync::Arc;

#[tokio::test]
#[ignore = "requires disposable Dovecot at 11993 and COMAIL_TLS_INSECURE=1"]
async fn exact_identity_search_and_chained_move_with_missing_uid() {
    assert!(imap::tls_insecure());
    let root = tempfile::tempdir().unwrap();
    let paths = Paths::for_tests(root.path());
    let core = Core::start(paths.clone()).await.unwrap();
    let mut session = imap::connect(
        "127.0.0.1",
        11993,
        imap::ImapCredentials::Password {
            user: "moveidentitye2e".into(),
            password: "pass".into(),
        },
    )
    .await
    .unwrap();
    let prefix = format!("MoveIdentity-{}", rand::random::<u128>());
    let folders = [
        format!("{prefix}-A"),
        format!("{prefix}-B"),
        format!("{prefix}-C"),
    ];
    let identity = format!("{prefix}@example.invalid");
    let mut validity = Vec::new();
    for folder in &folders {
        imap::create_folder(&mut session, folder).await.unwrap();
        validity.push(
            imap::select(&mut session, folder)
                .await
                .unwrap()
                .uid_validity
                .unwrap(),
        );
    }
    for id in [identity.clone(), format!("substring-{identity}")] {
        let raw = format!(
            "Message-ID: <{id}>\r\nFrom: fixture@example.invalid\r\nSubject: Synthetic identity\r\n\r\nSynthetic test\r\n"
        );
        imap::append(&mut session, &folders[0], raw.as_bytes(), false)
            .await
            .unwrap();
    }
    imap::select(&mut session, &folders[0]).await.unwrap();
    let matched = imap::uid_search_message_id(&mut session, &identity)
        .await
        .unwrap();
    assert_eq!(
        matched.len(),
        1,
        "HEADER substring match must not identify the other message"
    );
    assert!(
        imap::uid_search_message_id(&mut session, "missing@example.invalid")
            .await
            .unwrap()
            .is_empty()
    );
    let source_uid = matched[0];
    let raw = format!(
        "Message-ID: <{identity}>\r\nFrom: fixture@example.invalid\r\nSubject: Synthetic duplicate\r\n\r\nDuplicate test\r\n"
    );
    imap::append(&mut session, &folders[0], raw.as_bytes(), false)
        .await
        .unwrap();
    assert_eq!(
        imap::uid_search_message_id(&mut session, &identity)
            .await
            .unwrap()
            .len(),
        2,
        "return every exact match so queue can reject ambiguity"
    );
    let db_folders = folders.clone();
    let db_identity = identity.clone();
    core.db.write(move |conn| {
        conn.execute("INSERT INTO accounts(id,email,provider,auth_kind,username,imap_host,imap_port,smtp_host,smtp_port,created_at)
            VALUES(1,'fixture@example.invalid','imap','password','moveidentitye2e','127.0.0.1',11993,'127.0.0.1',10587,0)", [])?;
        for (index, name) in db_folders.iter().enumerate() {
            conn.execute("INSERT INTO folders(id,account_id,imap_name,uidvalidity) VALUES(?1,1,?2,?3)",
                rusqlite::params![(index+1) as i64,name,validity[index]])?;
        }
        conn.execute("INSERT INTO threads(id,account_id,subject_norm,last_message_at) VALUES(1,1,'synthetic',1000)", [])?;
        conn.execute("INSERT INTO messages(id,thread_id,account_id,folder_id,uid,message_id,subject,date,is_read)
            VALUES(1,1,1,1,?1,?2,'synthetic',1000,0)", rusqlite::params![source_uid,db_identity])?;
        repo::threads::recompute(conn, 1)?;
        Ok(())
    }).await.unwrap();
    for target in [2, 3] {
        core.perform_action(PerformActionArgs {
            kind: ActionKind::Move,
            thread_ids: vec![1],
            params: Some(ActionParams {
                target_folder_id: Some(target),
                wake_at: None,
                label_id: None,
            }),
        })
        .await
        .unwrap();
    }
    core.db
        .read(|conn| {
            let second = repo::actions::get(conn, 2)?.unwrap();
            assert!(second.payload["srcUid"].is_null());
            assert_eq!(second.payload["srcFolderId"], 2);
            assert!(second.payload["srcMessageId"].as_str().is_some());
            Ok(())
        })
        .await
        .unwrap();
    let ctx = SyncCtx {
        db: core.db.clone(),
        bus: core.bus.clone(),
        paths: Arc::new(paths),
        tokens: TokenProvider::new(),
    };
    let config = core
        .db
        .read(|conn| Ok(repo::accounts::get_config(conn, 1)?.unwrap()))
        .await
        .unwrap();
    for _ in 0..3 {
        queue::execute_due(&ctx, &config, &mut session)
            .await
            .unwrap();
    }
    core.db
        .read(|conn| {
            for id in [1, 2] {
                let action = repo::actions::get(conn, id)?.unwrap();
                assert_eq!(action.state, "done", "action {} must complete", id);
                assert!(action.payload["srcUid"].as_u64().unwrap() > 0);
                assert!(action.payload["srcUidValidity"].as_u64().unwrap() > 0);
            }
            Ok(())
        })
        .await
        .unwrap();
    imap::select(&mut session, &folders[0]).await.unwrap();
    assert_eq!(
        imap::uid_search_all(&mut session).await.unwrap().len(),
        2,
        "unrelated substring and duplicate remain"
    );
    imap::select(&mut session, &folders[1]).await.unwrap();
    assert!(imap::uid_search_all(&mut session).await.unwrap().is_empty());
    imap::select(&mut session, &folders[2]).await.unwrap();
    assert_eq!(
        imap::uid_search_message_id(&mut session, &identity)
            .await
            .unwrap()
            .len(),
        1
    );
}
