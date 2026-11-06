use super::*;
use serde_json::json;

fn read_trash_delete(conn: &mut rusqlite::Connection, snapshot: bool) -> (i64, i64, i64) {
    crate::db::testutil::seed_account(conn);
    conn.execute_batch("UPDATE folders SET uidvalidity=9 WHERE id=1;
        INSERT INTO folders(id,account_id,imap_name,role,uidvalidity) VALUES(2,1,'Trash','trash',10);") .unwrap();
    let (thread, message) =
        crate::db::testutil::seed_message(conn, "sender@test.dev", "sequence", false);
    conn.execute("UPDATE messages SET uid=7 WHERE id=?1", [message])
        .unwrap();
    let read = crate::apply_thread_action(conn, thread, ActionKind::MarkRead, None).unwrap()[0].0;
    crate::apply_thread_action(conn, thread, ActionKind::Trash, None).unwrap();
    if !snapshot {
        conn.execute(
            "UPDATE pending_actions SET payload='{}' WHERE id=?1",
            [read],
        )
        .unwrap();
    }
    let delete = repo::actions::enqueue(
        conn,
        1,
        crate::trash::KIND,
        Some(message),
        Some(thread),
        &json!({"trashFolderId":2}),
        None,
    )
    .unwrap();
    (read, message, delete)
}

#[test]
fn read_before_trash_resolves_snapshot_or_legacy_later_move_source() {
    for snapshot in [true, false] {
        let mut conn = crate::db::testutil::conn();
        let (read, message, delete) = read_trash_delete(&mut conn, snapshot);
        let action = repo::actions::get(&conn, read).unwrap().unwrap();
        if snapshot {
            assert_eq!(action.payload["folderId"], 1);
            assert_eq!(action.payload["uid"], 7);
            assert_eq!(action.payload["uidValidity"], 9);
        }
        let row = repo::messages::get_row(&conn, message).unwrap().unwrap();
        assert_eq!(row.folder_id, Some(2));
        assert_eq!(row.uid, None);
        let candidates = remote_candidates(&conn, &action).unwrap();
        assert!(
            candidates
                .iter()
                .any(|(folder, uid, epoch)| folder.id == 1 && *uid == 7 && *epoch == Some(9))
        );
        let due = repo::actions::due(&conn, 1, i64::MAX, 20).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, read);
        repo::actions::set_state(&conn, read, "done", None).unwrap();
        let due = repo::actions::due(&conn, 1, i64::MAX, 20).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].kind, "trash");
        repo::actions::set_state(&conn, due[0].id, "done", None).unwrap();
        assert_eq!(
            repo::actions::due(&conn, 1, i64::MAX, 20).unwrap()[0].id,
            delete
        );
    }
}

#[test]
fn snapshots_cover_star_actions() {
    let mut conn = crate::db::testutil::conn();
    crate::db::testutil::seed_account(&conn);
    conn.execute("UPDATE folders SET uidvalidity=9 WHERE id=1", [])
        .unwrap();
    let (thread, message) =
        crate::db::testutil::seed_message(&conn, "sender@test.dev", "snapshots", false);
    conn.execute("UPDATE messages SET uid=7 WHERE id=?1", [message])
        .unwrap();
    for kind in [ActionKind::Star, ActionKind::Unstar] {
        let id = crate::apply_thread_action(&mut conn, thread, kind, None).unwrap()[0].0;
        let action = repo::actions::get(&conn, id).unwrap().unwrap();
        assert_eq!(action.payload["folderId"], 1);
        assert_eq!(action.payload["uid"], 7);
        assert_eq!(action.payload["uidValidity"], 9);
    }
}

struct FlagRemote {
    selected: Vec<String>,
    validity: i64,
    hits: Vec<u32>,
}

impl MoveRemote for FlagRemote {
    async fn select_source(&mut self, folder: &str) -> Result<Option<i64>> {
        self.selected.push(folder.into());
        Ok(Some(self.validity))
    }
    async fn uid_exists(&mut self, _: u32) -> Result<bool> {
        Ok(true)
    }
    async fn search_key(&mut self, _: &crate::provider::RemoteKey) -> Result<Vec<u32>> {
        Ok(self.hits.clone())
    }
    async fn verify_key(&mut self, _: u32, _: &crate::provider::RemoteKey) -> Result<bool> {
        Ok(true)
    }
    async fn move_uid(&mut self, _: u32, _: &str) -> Result<Option<u32>> {
        unreachable!()
    }
}

#[tokio::test]
async fn actual_flag_resolution_unblocks_read_trash_delete_including_legacy_rows() {
    for snapshot in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let paths = crate::config::Paths::for_tests(root.path());
        let db = crate::db::Db::open(&paths.db_file()).unwrap();
        let action = db
            .write(move |conn| {
                let (read, _, _) = read_trash_delete(conn, snapshot);
                Ok(repo::actions::get(conn, read)?.unwrap())
            })
            .await
            .unwrap();
        let ctx = SyncCtx {
            db,
            bus: crate::events::EventBus::new(),
            paths: std::sync::Arc::new(paths),
            tokens: crate::oauth::tokens::TokenProvider::new(),
        };
        let mut remote = FlagRemote {
            selected: vec![],
            validity: 9,
            hits: vec![],
        };
        let (folder, uid) = resolve_remote(&ctx, &mut remote, &action)
            .await
            .unwrap()
            .unwrap();
        assert_eq!((folder.id, uid), (1, 7));
        assert_eq!(remote.selected, ["INBOX"]);
        let mut changed_epoch = FlagRemote {
            selected: vec![],
            validity: 11,
            hits: vec![],
        };
        assert!(matches!(
            resolve_remote(&ctx, &mut changed_epoch, &action).await,
            Err(CoreError::ActionDeferred(_))
        ));
    }
}
