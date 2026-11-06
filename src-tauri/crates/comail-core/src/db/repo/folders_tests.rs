use super::*;
use crate::db::testutil;
use crate::imap::RemoteFolder;
use crate::models::roles;
use crate::sync::folder_map::detect_role_with_source;

fn seed(gmail: bool) -> Connection {
    let c = testutil::conn();
    testutil::seed_account(&c);
    if gmail {
        c.execute("UPDATE accounts SET provider='gmail' WHERE id=1", [])
            .unwrap();
    }
    c
}

fn discover(c: &Connection, name: &str, attributes: &[&str]) -> i64 {
    let remote = RemoteFolder {
        name: name.into(),
        delimiter: Some("/".into()),
        attributes: attributes.iter().map(|s| s.to_string()).collect(),
    };
    upsert_detected(c, 1, name, Some("/"), detect_role_with_source(&remote)).unwrap()
}

#[test]
fn role_selection_prefers_special_use_over_names_regardless_of_ids() {
    for role in [
        roles::TRASH,
        roles::SENT,
        roles::DRAFTS,
        roles::SPAM,
        roles::ARCHIVE,
        roles::ALL,
    ] {
        for reverse in [false, true] {
            let c = seed(false);
            let entries = if reverse {
                [
                    (99, "Actual", RoleSource::SpecialUse),
                    (2, "A heuristic", RoleSource::Name),
                ]
            } else {
                [
                    (2, "Actual", RoleSource::SpecialUse),
                    (99, "A heuristic", RoleSource::Name),
                ]
            };
            for (id, name, source) in entries {
                c.execute("INSERT INTO folders(id,account_id,imap_name,role,role_source) VALUES (?1,1,?2,?3,?4)",params![id,name,role,source.as_str()]).unwrap();
            }
            let selected = by_role(&c, 1, role).unwrap().unwrap();
            assert_eq!(selected.imap_name, "Actual");
            assert_eq!(selected.role_source, RoleSource::SpecialUse);
        }
    }
}

#[test]
fn gmail_localized_special_use_beats_custom_trash_and_survives_upsert() {
    let c = seed(true);
    let deleted = discover(&c, "Deleted Items", &[]);
    let custom = discover(&c, "Trash", &[]);
    let native = discover(&c, "[Gmail]/Th&APk-ng r&AOE-c", &["trash"]);
    assert_eq!(by_role(&c, 1, roles::TRASH).unwrap().unwrap().id, native);
    assert!(!is_permanent_delete_trash(&c, deleted).unwrap());
    assert!(!is_permanent_delete_trash(&c, custom).unwrap());
    assert!(is_permanent_delete_trash(&c, native).unwrap());
    // Compatibility callers cannot erase evidence when writing the same role.
    assert_eq!(
        upsert(
            &c,
            1,
            "[Gmail]/Th&APk-ng r&AOE-c",
            Some("/"),
            Some(roles::TRASH)
        )
        .unwrap(),
        native
    );
    assert_eq!(
        get(&c, native).unwrap().unwrap().role_source,
        RoleSource::SpecialUse
    );
    // Fresh discovery does invalidate a role when the server removes it.
    discover(&c, "[Gmail]/Th&APk-ng r&AOE-c", &[]);
    assert!(by_role(&c, 1, roles::TRASH).unwrap().is_none());
    assert!(!is_permanent_delete_trash(&c, native).unwrap());
}

#[test]
fn gmail_legacy_cached_native_role_routes_but_is_not_destructive_evidence() {
    for name in ["[Gmail]/Th&APk-ng r&AOE-c", "[Google Mail]/Papierkorb"] {
        let c = seed(true);
        c.execute_batch(
            "INSERT INTO folders(id,account_id,imap_name,role) VALUES
            (7,1,'Deleted Items','trash'),(11,1,'Trash','trash');",
        )
        .unwrap();
        assert!(
            by_role(&c, 1, roles::TRASH).unwrap().is_none(),
            "custom labels alone are not destinations"
        );
        c.execute(
            "INSERT INTO folders(id,account_id,imap_name,role) VALUES (13,1,?1,'trash')",
            [name],
        )
        .unwrap();
        assert_eq!(by_role(&c, 1, roles::TRASH).unwrap().unwrap().id, 13);
        for id in [7, 11, 13] {
            assert!(!is_permanent_delete_trash(&c, id).unwrap());
        }
        discover(&c, name, &["\\Trash"]);
        assert!(is_permanent_delete_trash(&c, 13).unwrap());
    }
}

#[test]
fn gmail_host_accounts_and_native_name_heuristics_also_fail_closed_for_delete() {
    let c = seed(false);
    c.execute(
        "UPDATE accounts SET imap_host='IMAP.GMAIL.COM' WHERE id=1",
        [],
    )
    .unwrap();
    discover(&c, "Trash", &[]);
    assert!(by_role(&c, 1, roles::TRASH).unwrap().is_none());
    let native = discover(&c, "[Gmail]/Trash", &[]);
    assert_eq!(by_role(&c, 1, roles::TRASH).unwrap().unwrap().id, native);
    assert!(!is_permanent_delete_trash(&c, native).unwrap());
    assert_eq!(by_role(&c, 1, roles::INBOX).unwrap().unwrap().id, 1);
}

#[test]
fn non_gmail_legacy_and_name_fallback_are_stable_and_special_use_wins() {
    for reverse in [false, true] {
        let c = seed(false);
        let names = if reverse {
            ["Trash", "Deleted Items"]
        } else {
            ["Deleted Items", "Trash"]
        };
        for name in names {
            upsert(&c, 1, name, Some("/"), Some(roles::TRASH)).unwrap();
        }
        let selected = by_role(&c, 1, roles::TRASH).unwrap().unwrap();
        assert_eq!(selected.imap_name, "Deleted Items");
        assert!(is_permanent_delete_trash(&c, selected.id).unwrap());
        let actual = discover(&c, "Server Bin", &["trash"]);
        assert_eq!(by_role(&c, 1, roles::TRASH).unwrap().unwrap().id, actual);
        assert!(is_permanent_delete_trash(&c, actual).unwrap());
        assert!(!is_permanent_delete_trash(&c, selected.id).unwrap());
    }
}

#[test]
fn strict_normalization_demotes_only_conflicting_trash_roles_and_records_originals() {
    for role in [
        roles::TRASH,
        roles::SENT,
        roles::DRAFTS,
        roles::SPAM,
        roles::ARCHIVE,
        roles::ALL,
    ] {
        for reverse in [false, true] {
            let c = seed(true);
            let sources = [RoleSource::Legacy, RoleSource::Name, RoleSource::GmailName];
            for (index, source) in sources.into_iter().enumerate() {
                let name = format!("[Gmail]/Heuristic{index}");
                upsert_role(&c, 1, &name, Some("/"), Some(role), source).unwrap();
            }
            let names = if reverse {
                ["Server Z", "Server A"]
            } else {
                ["Server A", "Server Z"]
            };
            for name in names {
                upsert_role(&c, 1, name, Some("/"), Some(role), RoleSource::SpecialUse).unwrap();
            }
            assert_eq!(by_role(&c, 1, role).unwrap().unwrap().imap_name, "Server A");
            normalize_roles(&c, Some(1)).unwrap();
            normalize_roles(&c, None).unwrap();
            for folder in list(&c, Some(1)).unwrap() {
                if folder.imap_name.starts_with("[Gmail]/Heuristic") {
                    if role == roles::TRASH {
                        assert!(folder.role.is_none());
                        let recorded: String = c
                            .query_row(
                                "SELECT role FROM folder_role_repairs WHERE folder_id=?1",
                                [folder.id],
                                |r| r.get(0),
                            )
                            .unwrap();
                        assert_eq!(recorded, role);
                    } else {
                        assert_eq!(folder.role.as_deref(), Some(role));
                        assert_ne!(folder.role_source, RoleSource::SpecialUse);
                    }
                } else if folder.imap_name.starts_with("Server ") {
                    assert_eq!(folder.role.as_deref(), Some(role));
                    assert_eq!(folder.role_source, RoleSource::SpecialUse);
                }
            }
            assert_eq!(
                c.query_row("SELECT count(*) FROM folder_role_repairs", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                if role == roles::TRASH { 3 } else { 0 }
            );
        }
    }
}

#[test]
fn gmail_sent_label_remains_visible_while_special_use_is_the_move_target() {
    use crate::db::repo::threads::{self, ListArgs};
    use crate::models::View;
    use std::collections::BTreeSet;

    let c = seed(true);
    let label = discover(&c, "Sent", &[]);
    let native = discover(&c, "[Gmail]/Sent Mail", &["\\Sent"]);
    let mut expected = BTreeSet::new();
    for (folder_id, subject) in [(label, "label-only outgoing"), (native, "native outgoing")] {
        let (thread_id, message_id) = testutil::seed_message(&c, "me@test.dev", subject, true);
        c.execute(
            "UPDATE messages SET folder_id=?2,is_outgoing=1 WHERE id=?1",
            params![message_id, folder_id],
        )
        .unwrap();
        threads::recompute(&c, thread_id).unwrap();
        expected.insert(thread_id);
    }
    for _ in 0..2 {
        normalize_roles(&c, Some(1)).unwrap();
        assert_eq!(
            get(&c, label).unwrap().unwrap().role.as_deref(),
            Some(roles::SENT)
        );
        assert_eq!(
            get(&c, label).unwrap().unwrap().role_source,
            RoleSource::Name
        );
        assert_eq!(by_role(&c, 1, roles::SENT).unwrap().unwrap().id, native);
        let listed = threads::list(
            &c,
            &ListArgs {
                view: View::Sent,
                folder_id: None,
                tab: None,
                account_id: Some(1),
                cursor: None,
                limit: 20,
            },
        )
        .unwrap();
        assert_eq!(
            listed.threads.iter().map(|t| t.id).collect::<BTreeSet<_>>(),
            expected
        );
    }
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM folder_role_repairs WHERE folder_id=?1",
            [label],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn normalization_is_provider_and_account_scoped_and_preserves_native_fallback() {
    let c = seed(false);
    let generic = discover(&c, "Trash", &[]);
    discover(&c, "Server Bin", &["trash"]);
    normalize_roles(&c, None).unwrap();
    assert_eq!(
        get(&c, generic).unwrap().unwrap().role.as_deref(),
        Some(roles::TRASH)
    );
    c.execute(
        "UPDATE accounts SET imap_host='IMAP.GMAIL.COM' WHERE id=1",
        [],
    )
    .unwrap();
    let native = discover(&c, "[Gmail]/Sent Mail", &[]);
    normalize_roles(&c, Some(999)).unwrap();
    assert!(get(&c, generic).unwrap().unwrap().role.is_some());
    normalize_roles(&c, Some(1)).unwrap();
    assert!(get(&c, generic).unwrap().unwrap().role.is_none());
    assert_eq!(by_role(&c, 1, roles::SENT).unwrap().unwrap().id, native);
    assert!(get(&c, 1).unwrap().unwrap().role.is_some());
    assert_eq!(
        c.query_row("SELECT count(*) FROM folder_role_repairs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    c.execute("DELETE FROM folders WHERE id=?1", [generic])
        .unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM folder_role_repairs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn completed_role_repair_is_not_reopened_by_discovery() {
    let c = seed(true);
    let custom = discover(&c, "Trash", &[]);
    discover(&c, "Server Bin", &["trash"]);
    normalize_roles(&c, Some(1)).unwrap();
    let completed = || {
        c.query_row(
            "SELECT completed FROM folder_role_repairs WHERE folder_id=?1",
            [custom],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
    };
    assert_eq!(completed(), 0);
    c.execute(
        "UPDATE folder_role_repairs SET completed=1 WHERE folder_id=?1",
        [custom],
    )
    .unwrap();
    for _ in 0..2 {
        discover(&c, "Trash", &[]);
        normalize_roles(&c, Some(1)).unwrap();
        assert!(get(&c, custom).unwrap().unwrap().role.is_none());
        assert_eq!(completed(), 1);
    }
    assert_eq!(
        c.query_row("SELECT count(*) FROM folder_role_repairs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
