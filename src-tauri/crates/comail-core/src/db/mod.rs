//! SQLite access. WAL mode: one dedicated writer thread + one reader thread,
//! each owning a Connection. Async callers submit closures and await results,
//! so all repo code is plain synchronous rusqlite.

pub mod migrations;
pub mod repo;

use crate::error::{CoreError, Result};
use rusqlite::Connection;
use std::path::Path;
use std::sync::mpsc;
use tokio::sync::oneshot;

type Job = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

#[derive(Clone)]
pub struct Db {
    write_tx: mpsc::Sender<Job>,
    read_tx: mpsc::Sender<Job>,
}

fn spawn_conn_thread(path: std::path::PathBuf, name: &str) -> Result<mpsc::Sender<Job>> {
    let (tx, rx) = mpsc::channel::<Job>();
    let mut conn = open_connection(&path)?;
    std::thread::Builder::new()
        .name(format!("comail-db-{name}"))
        .spawn(move || {
            while let Ok(job) = rx.recv() {
                job(&mut conn);
            }
        })
        .map_err(CoreError::Io)?;
    Ok(tx)
}

fn open_connection(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    // Read-latency tuning: mmap the db file (256 MB window) so page reads
    // skip the syscall path, keep a 64 MB page cache, and spill temp
    // b-trees (sorts, group-bys) to memory instead of disk.
    conn.pragma_update(None, "mmap_size", 268_435_456i64)?;
    conn.pragma_update(None, "cache_size", -65_536i64)?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    Ok(conn)
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Run migrations on a throwaway connection before the threads start.
        {
            let mut conn = open_connection(path)?;
            migrations::run(&mut conn)?;
            repo::contacts::backfill_folded(&conn)?;
        }
        let write_tx = spawn_conn_thread(path.to_path_buf(), "writer")?;
        let read_tx = spawn_conn_thread(path.to_path_buf(), "reader")?;
        Ok(Db { write_tx, read_tx })
    }

    async fn call<T, F>(&self, tx: &mpsc::Sender<Job>, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(Box::new(move |conn| {
            let _ = reply_tx.send(f(conn));
        }))
        .map_err(|_| CoreError::Other("db thread gone".into()))?;
        reply_rx
            .await
            .map_err(|_| CoreError::Other("db call dropped".into()))?
    }

    /// Run a write (or transactional) closure on the writer connection.
    pub async fn write<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        self.call(&self.write_tx, f).await
    }

    /// Run a read-only closure on the reader connection.
    pub async fn read<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        self.call(&self.read_tx, f).await
    }
}

#[cfg(test)]
pub(crate) mod testutil {
    use rusqlite::{params, Connection};

    /// In-memory DB with all migrations applied.
    pub fn conn() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        super::migrations::run(&mut c).unwrap();
        c
    }

    /// Account 1 with an inbox folder 1, the minimum most repos need.
    pub fn seed_account(c: &Connection) {
        c.execute(
            "INSERT INTO accounts (id, email, provider, auth_kind, username,
             imap_host, imap_port, smtp_host, smtp_port, created_at)
             VALUES (1,'me@test.dev','imap','password','me','h',993,'h',587,0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO folders (id, account_id, imap_name, role) VALUES (1,1,'INBOX','inbox')",
            [],
        )
        .unwrap();
    }

    /// One incoming message in its own thread; returns (thread_id, message_id).
    pub fn seed_message(
        c: &Connection,
        from_addr: &str,
        subject: &str,
        is_automated: bool,
    ) -> (i64, i64) {
        c.execute(
            "INSERT INTO threads (account_id, subject_norm, unread_count, last_message_at)
             VALUES (1, ?1, 1, 1000)",
            params![subject.to_lowercase()],
        )
        .unwrap();
        let thread_id = c.last_insert_rowid();
        c.execute(
            "INSERT INTO messages (thread_id, account_id, folder_id, uid, message_id, subject,
             from_addr, date, is_read, is_automated, is_draft, is_outgoing)
             VALUES (?1, 1, 1, ?1, 'mid-' || ?1, ?2, ?3, 1000, 0, ?4, 0, 0)",
            params![thread_id, subject, from_addr, is_automated as i64],
        )
        .unwrap();
        let msg_id = c.last_insert_rowid();
        (thread_id, msg_id)
    }
}
