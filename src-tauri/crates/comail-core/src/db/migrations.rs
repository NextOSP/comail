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
];

pub fn run(conn: &mut Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let target = (i + 1) as i64;
        if version < target {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
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
}
