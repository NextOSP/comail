use crate::error::Result;
use rusqlite::{params, Connection, OptionalExtension};

pub fn set(
    conn: &Connection,
    thread_id: i64,
    account_id: i64,
    wake_at: i64,
    orig_folder_id: Option<i64>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO snoozes (thread_id, account_id, wake_at, orig_folder_id)
         VALUES (?1,?2,?3,?4)
         ON CONFLICT(thread_id) DO UPDATE SET wake_at = excluded.wake_at",
        params![thread_id, account_id, wake_at, orig_folder_id],
    )?;
    Ok(())
}

pub fn clear(conn: &Connection, thread_id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM snoozes WHERE thread_id = ?1",
        params![thread_id],
    )?;
    Ok(())
}

/// Threads whose wake time has passed.
pub fn woken(conn: &Connection, now_ms: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare("SELECT thread_id FROM snoozes WHERE wake_at <= ?1")?;
    let rows = stmt
        .query_map(params![now_ms], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn next_wake_at(conn: &Connection) -> Result<Option<i64>> {
    Ok(conn
        .query_row("SELECT MIN(wake_at) FROM snoozes", [], |r| {
            r.get::<_, Option<i64>>(0)
        })
        .optional()?
        .flatten())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testutil;

    #[test]
    fn set_wake_clear_lifecycle() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (t1, _) = testutil::seed_message(&c, "a@b.c", "one", false);
        let (t2, _) = testutil::seed_message(&c, "d@e.f", "two", false);

        set(&c, t1, 1, 1_000, Some(1)).unwrap();
        set(&c, t2, 1, 5_000, None).unwrap();
        // upsert moves the wake time instead of duplicating
        set(&c, t2, 1, 6_000, None).unwrap();

        assert_eq!(next_wake_at(&c).unwrap(), Some(1_000));
        assert_eq!(woken(&c, 1_500).unwrap(), vec![t1]);
        assert_eq!(woken(&c, 10_000).unwrap().len(), 2);
        assert!(woken(&c, 500).unwrap().is_empty());

        clear(&c, t1).unwrap();
        assert_eq!(next_wake_at(&c).unwrap(), Some(6_000));
    }
}
