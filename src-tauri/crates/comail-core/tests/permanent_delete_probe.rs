//! Destructive only inside a newly created folder on loopback Dovecot.
//! See docs/permanent-delete-plan.md for the isolated-container commands.

use comail_core::imap;

async fn connect(port: u16) -> imap::Session {
    imap::connect(
        "127.0.0.1",
        port,
        imap::ImapCredentials::Password {
            user: "permanentdeleteprobe".into(),
            password: "pass".into(),
        },
    )
    .await
    .expect("connect to disposable local Dovecot")
}

async fn fixture(session: &mut imap::Session) -> (String, Vec<u32>) {
    let folder = format!("DeleteProbe-{}", rand::random::<u128>());
    imap::create_folder(session, &folder).await.unwrap();
    for i in 0..3 {
        let raw = format!(
            "Message-ID: <{folder}-{i}@example.invalid>\r\n\
             From: Probe <probe@example.invalid>\r\n\
             To: Probe <probe@example.invalid>\r\n\
             Subject: Permanent delete fixture {i}\r\n\r\nSynthetic message {i}\r\n"
        );
        imap::append(session, &folder, raw.as_bytes(), false)
            .await
            .unwrap();
    }
    imap::select(session, &folder).await.unwrap();
    let mut uids = imap::uid_search_all(session).await.unwrap();
    uids.sort_unstable();
    assert_eq!(uids.len(), 3);
    (folder, uids)
}

async fn deleted_uids(session: &mut imap::Session) -> Vec<u32> {
    let mut uids: Vec<_> = session
        .uid_search("DELETED")
        .await
        .unwrap()
        .into_iter()
        .collect();
    uids.sort_unstable();
    uids
}

#[tokio::test]
#[ignore = "requires disposable Dovecot on 127.0.0.1:11993; see docs/permanent-delete-plan.md"]
async fn deletes_only_target_and_retry_is_idempotent() {
    assert!(
        imap::tls_insecure(),
        "set COMAIL_TLS_INSECURE=1 for the local fixture only"
    );
    let mut session = connect(11993).await;
    let (folder, uids) = fixture(&mut session).await;
    assert!(session.capabilities().await.unwrap().has_str("UIDPLUS"));

    // Another client's pending deletion must survive deleting our target.
    imap::store_flag(&mut session, uids[1], "\\Deleted", true)
        .await
        .unwrap();
    assert!(imap::uid_delete_permanently(&mut session, 0).await.is_err());
    assert_eq!(imap::uid_search_all(&mut session).await.unwrap().len(), 3);
    imap::uid_delete_permanently(&mut session, uids[0])
        .await
        .unwrap();
    assert!(
        imap::fetch_full(&mut session, uids[0])
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(deleted_uids(&mut session).await, vec![uids[1]]);

    // Repeat a completed deletion on a fresh connection (no fault injection).
    imap::logout(session).await;
    let mut session = connect(11993).await;
    imap::select(&mut session, &folder).await.unwrap();
    imap::uid_delete_permanently(&mut session, uids[0])
        .await
        .unwrap();
    let mut remaining = imap::uid_search_all(&mut session).await.unwrap();
    remaining.sort_unstable();
    assert_eq!(remaining, uids[1..]);
    assert_eq!(deleted_uids(&mut session).await, vec![uids[1]]);
    assert!(
        imap::fetch_full(&mut session, uids[2])
            .await
            .unwrap()
            .is_some()
    );

    // Positive control: plain EXPUNGE would have removed the unrelated mail.
    imap::expunge_all(&mut session).await.unwrap();
    assert_eq!(
        imap::uid_search_all(&mut session).await.unwrap(),
        vec![uids[2]]
    );
    imap::logout(session).await;
}

#[tokio::test]
#[ignore = "requires disposable Dovecot without UIDPLUS on 127.0.0.1:12993; see docs/permanent-delete-plan.md"]
async fn unsupported_server_is_rejected_before_any_mutation() {
    assert!(
        imap::tls_insecure(),
        "set COMAIL_TLS_INSECURE=1 for the local fixture only"
    );
    let mut session = connect(12993).await;
    let (_folder, uids) = fixture(&mut session).await;
    assert!(!session.capabilities().await.unwrap().has_str("UIDPLUS"));
    let err = imap::uid_delete_permanently(&mut session, uids[0])
        .await
        .expect_err("no unsafe fallback");
    assert!(err.to_string().contains("requires UIDPLUS"));
    assert!(deleted_uids(&mut session).await.is_empty());
    let mut remaining = imap::uid_search_all(&mut session).await.unwrap();
    remaining.sort_unstable();
    assert_eq!(remaining, uids);
    imap::logout(session).await;
}
