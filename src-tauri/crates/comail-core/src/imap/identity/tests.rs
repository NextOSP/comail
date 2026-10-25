use super::*;

fn parse_copyuid(response: &[u8], source: u32) -> Option<u32> {
    let (_, parsed) = Response::from_bytes(response).unwrap();
    match parsed {
        Response::Done {
            code: Some(code), ..
        }
        | Response::Data {
            code: Some(code), ..
        } => copyuid_destination(&code, source),
        _ => None,
    }
}

#[test]
fn copyuid_tagged_untagged_and_missing() {
    assert_eq!(
        parse_copyuid(b"A1 OK [COPYUID 99 5 42] moved\r\n", 5),
        Some(42)
    );
    assert_eq!(
        parse_copyuid(b"* OK [COPYUID 99 5 42] moved\r\n", 5),
        Some(42)
    );
    assert_eq!(parse_copyuid(b"A1 OK moved\r\n", 5), None);
    assert_eq!(parse_copyuid(b"A1 OK [COPYUID 99 6 42] moved\r\n", 5), None);
    assert_eq!(
        parse_copyuid(b"A1 OK [COPYUID 99 5:6 42:43] moved\r\n", 5),
        None
    );
    assert_eq!(
        parse_copyuid(b"A1 OK [COPYUID 99 5,6 42,43] moved\r\n", 5),
        None
    );
    assert_eq!(
        parse_copyuid(b"A1 OK [COPYUID 99 5:5 42:42] moved\r\n", 5),
        Some(42)
    );
}

#[test]
fn exact_verification_rejects_header_substrings_and_wrong_metadata() {
    let identity = FetchedIdentity {
        header_fetched: true,
        uid: 5,
        gm_msgid: Some("123".into()),

        message_id: Some("abc@example.test".into()),
        internal_date: Some(100),
        size: Some(900),
    };
    assert!(identity.matches(&RemoteKey::GmailMsgId(123)));
    assert!(!identity.matches(&RemoteKey::GmailMsgId(124)));
    assert!(!identity.matches(&RemoteKey::EmailId("Mabc".into())));
    assert!(!identity.matches(&RemoteKey::EmailId("Mab".into())));
    let header = |id: &str, date, size| RemoteKey::Header {
        message_id: id.into(),
        internal_date: date,
        size,
    };
    assert!(identity.matches(&header("<abc@example.test>", Some(100), Some(900))));
    assert!(identity.matches(&header("abc@example.test", None, None)));
    assert!(!identity.matches(&header("abc", None, None)));
    assert!(!identity.matches(&header("abc@example.test", Some(101), Some(900))));
    assert!(!identity.matches(&header("abc@example.test", Some(100), Some(901))));
}

#[test]
fn command_inputs_are_validated() {
    for valid in ["1:*", "1,5,9:12", "5"] {
        assert!(validate_uid_set(valid).is_ok());
    }
    for invalid in ["", "0", "1,,2", "1:2:3", "1\r\nEXPUNGE", "-1"] {
        assert!(validate_uid_set(invalid).is_err());
    }
    assert_eq!(quoted_mailbox("a\\b\"c").unwrap(), "\"a\\\\b\\\"c\"");
    assert!(quoted_mailbox("Trash\r\nEXPUNGE").is_err());
}

async fn scripted_session(
    script: Vec<(&'static str, String)>,
) -> (
    async_imap::Session<tokio::io::DuplexStream>,
    tokio::task::JoinHandle<()>,
) {
    scripted_session_mode(script, false).await
}

async fn scripted_session_mode(
    script: Vec<(&'static str, String)>,
    fragmented: bool,
) -> (
    async_imap::Session<tokio::io::DuplexStream>,
    tokio::task::JoinHandle<()>,
) {
    use tokio::io::AsyncWriteExt;
    let (client, mut server) = tokio::io::duplex(65536);
    let task = tokio::spawn(async move {
        for (expected, response) in script {
            let command = read_line(&mut server).await.unwrap();
            let (tag, actual) = command.trim_end().split_once(' ').unwrap();
            assert_eq!(actual, expected);
            let response = response.replace("$TAG", tag);
            let chunk_size = if fragmented { 3 } else { response.len() };
            for chunk in response.as_bytes().chunks(chunk_size) {
                server.write_all(chunk).await.unwrap();
                server.flush().await.unwrap();
                if fragmented {
                    tokio::task::yield_now().await;
                }
            }
        }
    });
    let client = async_imap::Client::new(client);
    let session = client.login("test", "test").await.unwrap();
    (session, task)
}

fn login() -> (&'static str, String) {
    ("LOGIN \"test\" \"test\"", "$TAG OK login\r\n".into())
}
fn capability(caps: &str) -> (&'static str, String) {
    (
        "CAPABILITY",
        format!("* CAPABILITY IMAP4rev1 {caps}\r\n$TAG OK capabilities\r\n"),
    )
}
fn header_fetch(gmail: bool) -> (&'static str, String) {
    let header = "Message-ID: <abc@example.test>\r\n\r\n";
    let query = if gmail {
        "UID FETCH 5 (UID INTERNALDATE RFC822.SIZE X-GM-MSGID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])"
    } else {
        "UID FETCH 5 (UID INTERNALDATE RFC822.SIZE  BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])"
    };
    let extra = if gmail { "X-GM-MSGID 123 " } else { "" };
    (
        query,
        format!(
            "* 1 FETCH (UID 5 INTERNALDATE \"01-Jan-2024 00:00:00 +0000\" RFC822.SIZE 900 {extra}BODY[HEADER.FIELDS (MESSAGE-ID)] {{{}}}\r\n{header})\r\n$TAG OK fetched\r\n",
            header.len()
        ),
    )
}

#[tokio::test]
async fn fake_protocol_gmail_search_verifies_stable_id_and_header() {
    let (mut session, task) = scripted_session(vec![
        login(),
        (
            "UID SEARCH X-GM-MSGID 123",
            "* SEARCH 5\r\n$TAG OK searched\r\n".into(),
        ),
        header_fetch(true),
    ])
    .await;
    assert_eq!(
        uid_search_remote_key(&mut session, &RemoteKey::GmailMsgId(123), &*test_behavior())
            .await
            .unwrap(),
        vec![5]
    );
    task.await.unwrap();
}

#[tokio::test]
async fn fake_protocol_header_search_handles_fragmented_and_coalesced_responses() {
    for fragmented in [false, true] {
        let mut fetch = header_fetch(false);
        fetch.1.push_str("* 8 EXISTS\r\n");
        let (mut session, task) = scripted_session_mode(
            vec![
                login(),
                (
                    "UID SEARCH HEADER Message-ID \"abc@example.test\"",
                    "* SEARCH 5\r\n$TAG OK searched\r\n".into(),
                ),
                fetch,
                capability("OBJECTID UIDPLUS"),
            ],
            fragmented,
        )
        .await;
        let key = RemoteKey::Header {
            message_id: "abc@example.test".into(),
            internal_date: Some(1704067200),
            size: Some(900),
        };
        assert_eq!(
            uid_search_remote_key(
                &mut session,
                &key,
                &*crate::provider::behavior_for(crate::models::Provider::Imap, &Default::default())
            )
            .await
            .unwrap(),
            vec![5]
        );
        assert!(
            crate::provider::ServerCaps::from_session(&mut session)
                .await
                .unwrap()
                .objectid
        );
        task.await.unwrap();
    }
}

#[tokio::test]
async fn omitted_header_section_cannot_prove_header_identity_absent() {
    for header in [None, Some("From: sender@example.test\r\n\r\n")] {
        let body = header
            .map(|header| {
                format!(
                    " BODY[HEADER.FIELDS (MESSAGE-ID)] {{{}}}\r\n{header}",
                    header.len()
                )
            })
            .unwrap_or_default();
        let (mut session, task) = scripted_session(vec![login(), (
            "UID FETCH 5 (UID INTERNALDATE RFC822.SIZE X-GM-MSGID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])",
            format!("* 1 FETCH (UID 5 INTERNALDATE \"01-Jan-2024 00:00:00 +0000\" RFC822.SIZE 900 X-GM-MSGID 123{body})\r\n$TAG OK fetched\r\n"),
        )]).await;
        let identities = fetch_identities(&mut session, "5", &*test_behavior())
            .await
            .unwrap();
        assert_eq!(identities.len(), 1);
        assert_eq!(identities[0].header_fetched, header.is_some());
        assert!(identities[0].message_id.is_none());
        let key = RemoteKey::Header {
            message_id: "abc@example.test".into(),
            internal_date: None,
            size: None,
        };
        assert_eq!(key.identity_complete(&identities), header.is_some());
        assert!(
            RemoteKey::GmailMsgId(456).identity_complete(&identities),
            "missing headers do not invalidate stable provider identities"
        );
        task.await.unwrap();
    }
}

#[tokio::test]
async fn deferred_emailid_keys_fail_closed_without_remote_commands() {
    let (mut session, task) = scripted_session(vec![login()]).await;
    let key = RemoteKey::EmailId("Mabc".into());
    assert!(matches!(
        uid_search_remote_key(&mut session, &key, &*test_behavior()).await,
        Err(CoreError::ActionRejected(_))
    ));
    assert!(matches!(
        verify_remote_key(&mut session, 5, &key, &*test_behavior()).await,
        Err(CoreError::ActionRejected(_))
    ));
    task.await.unwrap();
}

#[tokio::test]
async fn legacy_cleanup_targets_only_deleted_snapshot() {
    let (mut session, task) = scripted_session(vec![
        login(),
        capability("UIDPLUS"),
        (
            "UID SEARCH DELETED",
            "* SEARCH 9 5\r\n$TAG OK searched\r\n".into(),
        ),
        (
            "UID EXPUNGE 5,9",
            "* 1 EXPUNGE\r\n$TAG OK cleanup\r\n".into(),
        ),
    ])
    .await;
    expunge_all_inner(&mut session).await.unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn legacy_cleanup_requires_uidplus_and_skips_empty_snapshot() {
    let (mut session, task) = scripted_session(vec![login(), capability("")]).await;
    assert!(matches!(
        expunge_all_inner(&mut session).await,
        Err(CoreError::DeleteRejected(_))
    ));
    task.await.unwrap();
    let (mut session, task) = scripted_session(vec![
        login(),
        capability("UIDPLUS"),
        (
            "UID SEARCH DELETED",
            "* SEARCH\r\n$TAG OK searched\r\n".into(),
        ),
    ])
    .await;
    expunge_all_inner(&mut session).await.unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn fake_protocol_copyuid_survives_tagged_and_untagged_responses() {
    for operation in ["COPY", "MOVE"] {
        let command = if operation == "COPY" {
            "UID COPY 5 \"Trash\""
        } else {
            "UID MOVE 5 \"Trash\""
        };
        for response in [
            "$TAG OK [COPYUID 99 5 42] done\r\n",
            "* OK [COPYUID 99 5 42] copied\r\n$TAG OK moved\r\n",
        ] {
            let (mut session, task) =
                scripted_session(vec![login(), (command, response.into())]).await;
            assert_eq!(
                copy_or_move(&mut session, operation, "5", "Trash")
                    .await
                    .unwrap(),
                Some(42)
            );
            task.await.unwrap();
        }
    }
}

#[tokio::test]
async fn fake_protocol_failed_move_never_accepts_early_copyuid() {
    let (mut session, task) = scripted_session(vec![
        login(),
        (
            "UID MOVE 5 \"Trash\"",
            "* OK [COPYUID 99 5 42] copied\r\n$TAG NO denied\r\n".into(),
        ),
    ])
    .await;
    assert!(
        copy_or_move(&mut session, "MOVE", "5", "Trash")
            .await
            .is_err()
    );
    task.await.unwrap();
}

// The scripted server reads commands bytewise; production never bypasses the codec.
async fn read_line<R: tokio::io::AsyncRead + Unpin>(stream: &mut R) -> Result<String> {
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    loop {
        let byte = stream
            .read_u8()
            .await
            .map_err(|e| CoreError::Imap(e.to_string()))?;
        bytes.push(byte);
        if byte == b'\n' {
            break;
        }
    }
    Ok(String::from_utf8(bytes).unwrap())
}

#[tokio::test]
async fn stable_backfill_fetch_is_bulk_and_does_not_fetch_headers_or_capabilities() {
    let (mut session, task) = scripted_session(vec![
        login(),
        (
            "UID FETCH 5,9 (UID X-GM-MSGID)",
            "* 1 FETCH (UID 5 X-GM-MSGID 123)\r\n* 2 FETCH (UID 9 X-GM-MSGID 456)\r\n$TAG OK fetched\r\n".into(),
        ),
    ]).await;
    let identities = fetch_stable_identities(&mut session, "5,9", &*test_behavior())
        .await
        .unwrap();
    assert_eq!(identities.len(), 2);
    assert_eq!(identities[0].remote_key(), Some(RemoteKey::GmailMsgId(123)));
    assert_eq!(identities[1].remote_key(), Some(RemoteKey::GmailMsgId(456)));
    assert!(identities.iter().all(|item| item.message_id.is_none()));
    task.await.unwrap();
}

fn test_behavior() -> Box<dyn crate::provider::MailboxBehavior> {
    crate::provider::behavior_for(
        crate::models::Provider::Gmail,
        &crate::provider::ServerCaps {
            gmail_ext: true,
            ..Default::default()
        },
    )
}
