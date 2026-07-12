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
