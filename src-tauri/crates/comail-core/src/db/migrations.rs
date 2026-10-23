use crate::error::Result;
use rusqlite::Connection;

const MIGRATIONS: &[&str] = &[
    include_str!("migrations/001_init.sql"),
    include_str!("migrations/002_perf_indexes.sql"),
    include_str!("migrations/003_unsub_attach_calendar.sql"),
    include_str!("migrations/004_embeddings.sql"),
    include_str!("migrations/005_labels.sql"),
    include_str!("migrations/006_contact_fold.sql"),
    include_str!("migrations/007_auto_labels.sql"),
    include_str!("migrations/008_calendar_rsvp.sql"),
    include_str!("migrations/009_caldav.sql"),
    include_str!("migrations/010_sender_via.sql"),
    include_str!("migrations/011_robot_automated.sql"),
    include_str!("migrations/012_sync_resilience.sql"),
    include_str!("migrations/013_fts_contentless_delete.sql"),
    include_str!("migrations/014_routing.sql"),
    include_str!("migrations/015_ai_automation_annotations.sql"),
    include_str!("migrations/016_ai_usage.sql"),
    include_str!("migrations/017_contact_accounts.sql"),
    include_str!("migrations/018_series_master.sql"),
    include_str!("migrations/019_list_unsubscribe_post.sql"),
    include_str!("migrations/020_attachment_inline_fix.sql"),
    include_str!("migrations/021_search_history.sql"),
    include_str!("migrations/022_contact_send_backfill.sql"),
    include_str!("migrations/023_split_condition.sql"),
    include_str!("migrations/024_automation_applied.sql"),
    include_str!("migrations/025_automations_all_mail.sql"),
    include_str!("migrations/026_split_ai_check.sql"),
    include_str!("migrations/027_split_count_all.sql"),
    include_str!("migrations/028_permanent_delete_visibility.sql"),
    include_str!("migrations/029_folder_role_provenance.sql"),
    include_str!("migrations/030_trash_identity_recovery.sql"),
    include_str!("migrations/031_remote_identity.sql"),
    include_str!("migrations/032_stable_identity_cursor.sql"),
    include_str!("migrations/033_folder_role_repairs.sql"),
    include_str!("migrations/034_stable_identity_attempts.sql"),
    include_str!("migrations/035_restore_non_trash_roles.sql"),
];

pub fn run(conn: &mut Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let target = (i + 1) as i64;
        if version < target {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            if target == 33 {
                crate::db::repo::folders::normalize_roles(&tx, None)?;
            }
            tx.pragma_update(None, "user_version", target)?;
            tx.commit()?;
            tracing::info!("applied db migration {target}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn run_through(conn: &mut Connection, version: usize) {
        for (i, sql) in MIGRATIONS.iter().take(version).enumerate() {
            let target = (i + 1) as i64;
            let tx = conn.transaction().unwrap();
            tx.execute_batch(sql).unwrap();
            tx.pragma_update(None, "user_version", target).unwrap();
            tx.commit().unwrap();
        }
    }

    #[test]
    fn migration_033_normalizes_strict_accounts_and_persists_repair_sources() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_through(&mut conn, 32);
        crate::db::testutil::seed_account(&conn);
        conn.execute(
            "UPDATE accounts SET imap_host='imap.gmail.com' WHERE id=1",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO folders(id,account_id,imap_name,role,role_source,uidvalidity,last_seen_uid)
             VALUES (7,1,'Trash','trash','name',42,123),
                    (8,1,'Deleted Items','trash','legacy',43,124),
                    (9,1,'[Gmail]/Bin','trash','gmail_name',44,125),
                    (10,1,'Server Bin','trash','special_use',45,126),
                    (11,1,'[Gmail]/Sent Mail','sent','gmail_name',46,127);",
        ).unwrap();
        run(&mut conn).unwrap();
        run(&mut conn).unwrap();
        for id in [7, 8, 9] {
            let folder = crate::db::repo::folders::get(&conn, id).unwrap().unwrap();
            assert!(folder.role.is_none());
            assert_eq!(folder.uidvalidity, Some(35 + id));
            assert_eq!(folder.last_seen_uid, 116 + id);
            assert_eq!(
                conn.query_row(
                    "SELECT role FROM folder_role_repairs WHERE folder_id=?1",
                    [id],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                "trash"
            );
        }
        assert_eq!(
            crate::db::repo::folders::by_role(&conn, 1, "trash")
                .unwrap()
                .unwrap()
                .id,
            10
        );
        assert_eq!(
            crate::db::repo::folders::by_role(&conn, 1, "sent")
                .unwrap()
                .unwrap()
                .id,
            11
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM folder_role_repairs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }

    #[test]
    fn migration_035_restores_non_trash_roles_only_when_still_unassigned() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_through(&mut conn, 34);
        crate::db::testutil::seed_account(&conn);
        conn.execute_batch(
            "INSERT INTO folders(id,account_id,imap_name,role,role_source)
             VALUES (10,1,'Sent',NULL,'legacy'),
                    (11,1,'Trash',NULL,'legacy'),
                    (12,1,'Drafts','archive','special_use'),
                    (13,1,'Archive',NULL,'legacy'),
                    (14,1,'Spam',NULL,'legacy');
             INSERT INTO folder_role_repairs(folder_id,role,completed)
             VALUES (10,'sent',1),(11,'trash',0),(12,'drafts',1),
                    (13,'archive',0),(14,'spam',1);",
        )
        .unwrap();
        run(&mut conn).unwrap();
        for (id, expected) in [
            (10, Some("sent")),
            (11, None),
            (12, Some("archive")),
            (13, Some("archive")),
            (14, Some("spam")),
        ] {
            assert_eq!(
                crate::db::repo::folders::get(&conn, id)
                    .unwrap()
                    .unwrap()
                    .role
                    .as_deref(),
                expected
            );
        }
        assert_eq!(
            conn.query_row(
                "SELECT role || ':' || completed FROM folder_role_repairs WHERE folder_id=11",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "trash:0"
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM folder_role_repairs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            5
        );
        run(&mut conn).unwrap();
        assert_eq!(
            crate::db::repo::folders::get(&conn, 10)
                .unwrap()
                .unwrap()
                .role
                .as_deref(),
            Some("sent")
        );
    }

    #[test]
    fn migration_033_rolls_back_schema_and_version_if_normalization_fails() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_through(&mut conn, 32);
        crate::db::testutil::seed_account(&conn);
        conn.execute_batch(
            "UPDATE accounts SET provider='gmail' WHERE id=1;
             INSERT INTO folders(account_id,imap_name,role,role_source)
             VALUES (1,'Trash','trash','name'), (1,'Server Bin','trash','special_use');
             CREATE TRIGGER reject_role_update BEFORE UPDATE OF role ON folders
             BEGIN SELECT RAISE(ABORT, 'fixture rejects normalization'); END;",
        )
        .unwrap();
        assert!(run(&mut conn).is_err());
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            32
        );
        assert!(
            !conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='folder_role_repairs')",
                    [],
                    |r| r.get::<_, bool>(0)
                )
                .unwrap()
        );
        assert_eq!(
            conn.query_row(
                "SELECT role FROM folders WHERE imap_name='Trash'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "trash"
        );
        conn.execute_batch("DROP TRIGGER reject_role_update")
            .unwrap();
        run(&mut conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM folder_role_repairs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn migration_031_upgrades_applied_v1_without_losing_pending_delete() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_through(&mut conn, 30);
        crate::db::testutil::seed_account(&conn);
        let (_, mid) = crate::db::testutil::seed_message(&conn, "old@test", "legacy", false);
        conn.execute(
            "INSERT INTO trash_identity_recovery(message_id) VALUES(?1)",
            [mid],
        )
        .unwrap();
        conn.execute("UPDATE messages SET uid=NULL WHERE id=?1", [mid])
            .unwrap();
        conn.execute("INSERT INTO pending_actions(account_id,message_id,kind,payload,created_at) VALUES(1,?1,'delete_permanently','{}',0)", [mid]).unwrap();
        run(&mut conn).unwrap();
        run(&mut conn).unwrap();
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            MIGRATIONS.len() as i64
        );
        assert!(!conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='trash_identity_recovery')", [], |r| r.get::<_, bool>(0)).unwrap());
        assert!(!conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='idx_actions_permanent_delete_identity')", [], |r| r.get::<_, bool>(0)).unwrap());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM messages WHERE id=?1", [mid], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM visible_messages", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        conn.execute("UPDATE pending_actions SET state='failed'", [])
            .unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM visible_messages", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn migration_029_keeps_legacy_role_evidence_unknown() {
        let mut c = Connection::open_in_memory().unwrap();
        run_through(&mut c, 28);
        crate::db::testutil::seed_account(&c);
        c.execute("UPDATE accounts SET provider='gmail' WHERE id=1", [])
            .unwrap();
        c.execute_batch(
            "INSERT INTO folders(id,account_id,imap_name,role,uidvalidity,last_seen_uid)
            VALUES (7,1,'Deleted Items','trash',42,123),
                   (11,1,'Trash','trash',43,124),
                   (13,1,'[Gmail]/Th&APk-ng r&AOE-c','trash',44,125);",
        )
        .unwrap();
        run(&mut c).unwrap();
        let inbox = crate::db::repo::folders::get(&c, 1).unwrap().unwrap();
        assert_eq!(
            inbox.role_source,
            crate::db::repo::folders::RoleSource::Inbox
        );
        for (id, generation, last_uid) in [(7, 42, 123), (11, 43, 124), (13, 44, 125)] {
            let folder = crate::db::repo::folders::get(&c, id).unwrap().unwrap();
            assert_eq!(folder.role.as_deref(), Some("trash"));
            assert_eq!(
                folder.role_source,
                crate::db::repo::folders::RoleSource::Legacy
            );
            assert_eq!(
                (folder.uidvalidity, folder.last_seen_uid),
                (Some(generation), last_uid)
            );
            assert!(!crate::db::repo::folders::is_permanent_delete_trash(&c, id).unwrap());
        }
        assert_eq!(
            crate::db::repo::folders::by_role(&c, 1, "trash")
                .unwrap()
                .unwrap()
                .id,
            13
        );
    }

    #[test]
    fn migration_012_is_additive_and_preserves_legacy_cache_fields() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_through(&mut conn, 11);
        conn.execute(
            "INSERT INTO accounts (id, email, provider, auth_kind, username,
             imap_host, imap_port, smtp_host, smtp_port, created_at)
             VALUES (1, 'me@test.dev', 'imap', 'password', 'me', 'h', 993, 'h', 587, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folders (id, account_id, imap_name, role)
             VALUES (1, 1, 'INBOX', 'inbox')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO threads (id, account_id, subject_norm) VALUES (1, 1, 'legacy')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (
               id, account_id, thread_id, folder_id, uid, subject, date, raw_path, body_state
             ) VALUES (1, 1, 1, 1, 7, 'Legacy', 1, '/cache/legacy.eml', 'cached')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments (
               id, message_id, part_id, filename, file_path
             ) VALUES (1, 1, 'legacy-2', 'report.pdf', '/cache/report.pdf')",
            [],
        )
        .unwrap();

        let tx = conn.transaction().unwrap();
        tx.execute_batch(MIGRATIONS[11]).unwrap();
        tx.pragma_update(None, "user_version", 12).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            12
        );
        let message_columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'mime_plan_json'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let attachment_columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('attachments') WHERE name = 'imap_section'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((message_columns, attachment_columns), (1, 1));

        let legacy: (String, String, String) = conn
            .query_row(
                "SELECT m.raw_path, a.part_id, a.file_path
                 FROM messages m JOIN attachments a ON a.message_id = m.id
                 WHERE m.id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            legacy,
            (
                "/cache/legacy.eml".into(),
                "legacy-2".into(),
                "/cache/report.pdf".into()
            )
        );

        conn.execute("UPDATE attachments SET imap_section = '2' WHERE id = 1", [])
            .unwrap();
        let duplicate = conn.execute(
            "INSERT INTO attachments (message_id, part_id, imap_section) VALUES (1, 'new', '2')",
            params![],
        );
        assert!(
            duplicate.is_err(),
            "IMAP section must be unique per message"
        );
    }

    #[test]
    fn migration_013_rebuilds_fts_with_real_delete_support() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_through(&mut conn, 12);
        conn.execute(
            "INSERT INTO accounts (id, email, provider, auth_kind, username,
             imap_host, imap_port, smtp_host, smtp_port, created_at)
             VALUES (1, 'me@test.dev', 'imap', 'password', 'me', 'h', 993, 'h', 587, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folders (id, account_id, imap_name, role)
             VALUES (1, 1, 'INBOX', 'inbox')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO threads (id, account_id, subject_norm) VALUES (1, 1, 'legacy')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (
               id, account_id, thread_id, folder_id, uid, subject, from_addr,
               to_json, cc_json, date, snippet
             ) VALUES (
               1, 1, 1, 1, 7, 'Legacy', 'sender@test.dev', '[]', '[]', 1,
               'rebuiltuniqueterm'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages_fts (rowid, subject, from_text, to_text, body)
             VALUES (1, 'Legacy', 'sender@test.dev', '', 'staleuniqueterm')",
            [],
        )
        .unwrap();

        run(&mut conn).unwrap();
        let matches = |term: &str| {
            conn.query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH ?1",
                params![term],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
        };
        assert_eq!(matches("staleuniqueterm"), 0);
        assert_eq!(matches("rebuiltuniqueterm"), 1);
        conn.execute("DELETE FROM messages_fts WHERE rowid = 1", [])
            .unwrap();
        assert_eq!(matches("rebuiltuniqueterm"), 0);
    }

    #[test]
    fn migration_015_adds_local_automation_annotations() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_through(&mut conn, 14);
        run(&mut conn).unwrap();
        let columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('messages')
                 WHERE name IN ('local_subject_prefix', 'local_body_note')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(columns, 2);
    }

    #[test]
    fn migration_022_counts_mail_sent_from_comail() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_through(&mut conn, 21);
        conn.execute_batch(
            "INSERT INTO accounts (id, email, provider, auth_kind, username,
               imap_host, imap_port, smtp_host, smtp_port, created_at)
             VALUES (1, 'me@test.dev', 'imap', 'password', 'me', 'h', 993, 'h', 587, 0);
             INSERT INTO threads (id, account_id, subject_norm) VALUES (1, 1, 's');
             INSERT INTO contacts (id, email, name, send_count, recv_count, last_interacted)
             VALUES (1, 'bao@acme.com', 'Bao', 0, 4, 10);
             INSERT INTO contact_accounts (contact_id, account_id, send_count, recv_count, last_interacted)
             VALUES (1, 1, 0, 4, 10);
             -- two sends to bao (one via bcc), one to a never-harvested address,
             -- and an unsent draft that must not count.
             INSERT INTO messages (id, account_id, thread_id, subject, date, is_outgoing, is_draft, to_json, bcc_json)
             VALUES (1, 1, 1, 's', 100, 1, 0, '[{\"email\":\"Bao@acme.com\"}]', '[]'),
                    (2, 1, 1, 's', 200, 1, 0, '[{\"name\":\"Kim\",\"email\":\"kim@acme.com\"}]',
                                             '[{\"email\":\"bao@acme.com\"}]'),
                    (3, 1, 1, 's', 300, 1, 1, '[{\"email\":\"bao@acme.com\"}]', '[]');",
        )
        .unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute_batch(MIGRATIONS[21]).unwrap();
        tx.commit().unwrap();

        let row = |sql: &str| -> (i64, i64, i64) {
            conn.query_row(sql, [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
        };
        assert_eq!(
            row(
                "SELECT send_count, recv_count, last_interacted FROM contacts WHERE email = 'bao@acme.com'"
            ),
            (2, 4, 200)
        );
        assert_eq!(
            row(
                "SELECT send_count, recv_count, last_interacted FROM contact_accounts WHERE contact_id = 1"
            ),
            (2, 4, 200)
        );
        assert_eq!(
            row("SELECT ca.send_count, ca.recv_count, ca.last_interacted
                 FROM contacts c JOIN contact_accounts ca ON ca.contact_id = c.id
                 WHERE c.email = 'kim@acme.com' AND c.name = 'Kim'"),
            (1, 0, 200)
        );
    }
}
