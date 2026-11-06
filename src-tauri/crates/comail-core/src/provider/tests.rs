use super::*;

#[test]
fn capability_driven_selection_and_provider_hints() {
    let generic = behavior_for(Provider::Imap, &ServerCaps::default());
    assert!(generic.identity_fetch_items().is_empty());
    assert_eq!(generic.trash_name_hints()[0], "Trash");
    let caps = ServerCaps {
        gmail_ext: true,
        objectid: true,
        ..Default::default()
    };
    let unknown = behavior_for(Provider::Imap, &caps);
    assert_eq!(unknown.identity_fetch_items(), &["X-GM-MSGID"]);
    assert_eq!(unknown.trash_name_hints()[0], "[Gmail]/Trash");
    let microsoft = behavior_for(Provider::Microsoft, &ServerCaps::default());
    assert_eq!(microsoft.trash_name_hints()[0], "Deleted Items");
    let gmail_without_extension = behavior_for(Provider::Gmail, &ServerCaps::default());
    assert!(gmail_without_extension.identity_fetch_items().is_empty());
    let objectid = behavior_for(
        Provider::Imap,
        &ServerCaps {
            objectid: true,
            ..Default::default()
        },
    );
    assert!(objectid.identity_fetch_items().is_empty());
}

#[test]
fn criteria_and_serialization_per_identity() {
    let behavior = behavior_for(Provider::Imap, &ServerCaps::default());
    for (key, query) in [
        (RemoteKey::GmailMsgId(123), "X-GM-MSGID 123"),
        (
            RemoteKey::Header {
                message_id: " <a@example.test> ".into(),
                internal_date: Some(42),
                size: Some(99),
            },
            "HEADER Message-ID \"a@example.test\"",
        ),
    ] {
        assert_eq!(behavior.search_criteria(&key), query);
        let json = serde_json::to_string(&key).unwrap();
        assert_eq!(serde_json::from_str::<RemoteKey>(&json).unwrap(), key);
    }
}

#[test]
fn untrusted_keys_cannot_inject_imap_commands() {
    for key in [
        RemoteKey::GmailMsgId(0),
        RemoteKey::EmailId("x) UID 1:*".into()),
        RemoteKey::EmailId("x\r\nEXPUNGE".into()),
        RemoteKey::Header {
            message_id: "x\nEXPUNGE".into(),
            internal_date: None,
            size: None,
        },
    ] {
        assert!(key.checked_search_criteria().is_err());
    }
}

#[test]
fn persisted_identity_prefers_strongest_and_normalizes_header() {
    assert_eq!(
        key_from_parts(Some("123"), Some("<a@b>"), None, None),
        Some(RemoteKey::GmailMsgId(123))
    );
    assert_eq!(
        key_from_parts(Some("invalid"), Some("<a@b>"), None, None),
        Some(RemoteKey::Header {
            message_id: "a@b".into(),
            internal_date: None,
            size: None
        })
    );
    assert_eq!(
        key_from_parts(None, Some(" <a@b> "), Some(100), Some(20)),
        Some(RemoteKey::Header {
            message_id: "a@b".into(),
            internal_date: Some(100),
            size: Some(20)
        })
    );
    assert_eq!(key_from_parts(None, Some("  "), None, None), None);
}

#[test]
fn provider_controls_role_evidence_without_network() {
    let gmail = behavior_for_account("imap", "imap.googlemail.com");
    assert!(gmail.requires_special_use_for_delete());
    assert_eq!(gmail.role_name_rank("Trash"), None);
    assert_eq!(gmail.role_name_rank("[Google Mail]/Bin"), Some(2));
    let microsoft = behavior_for_account("microsoft", "outlook.office365.com");
    assert!(!microsoft.requires_special_use_for_delete());
    assert_eq!(microsoft.role_name_rank("Deleted Items"), Some(1));
}

#[test]
fn identity_policy_is_bucket_local_for_headers_and_global_for_stable_ids() {
    let header = key_from_parts(None, Some("<a@b>"), Some(100), Some(20)).unwrap();
    let mut listing = vec![FetchedIdentity {
        header_fetched: true,
        uid: 1,
        gm_msgid: Some("123".into()),
        message_id: Some("a@b".into()),
        internal_date: Some(100),
        size: Some(20),
    }];
    assert!(listing[0].matches(&header));
    assert_eq!(listing[0].buckets(), vec!["g:123", "h:a@b"]);
    assert!(header.identity_complete(&listing));
    assert!(!header.allows_multiple_matches());
    assert!(RemoteKey::GmailMsgId(123).allows_multiple_matches());
    listing.push(FetchedIdentity {
        header_fetched: true,
        uid: 2,
        gm_msgid: None,
        message_id: None,
        internal_date: None,
        size: None,
    });
    assert!(header.identity_complete(&listing));
    assert!(!RemoteKey::GmailMsgId(123).identity_complete(&listing));
    listing[1].message_id = Some("a@b".into());
    assert!(!header.identity_complete(&listing));
    assert!(!RemoteKey::EmailId("future".into()).identity_complete(&[]));
    assert!(
        RemoteKey::EmailId("future".into())
            .ensure_supported()
            .is_err()
    );
}
