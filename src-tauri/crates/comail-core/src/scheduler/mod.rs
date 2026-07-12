//! Wakes snoozed threads and nudges account actors when timed actions
//! (send-later, undo-send windows) come due. Timers are app-local: anything
//! past due fires on the next tick or at launch.

use crate::db::repo;
use crate::db::Db;
use crate::events::{CoreEvent, EventBus};
use crate::models::now_ms;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::sync::engine::{AccountHandle, SyncCmd};

const TICK_SECS: u64 = 5;

pub fn spawn(
    db: Db,
    bus: EventBus,
    handles: Arc<RwLock<HashMap<i64, AccountHandle>>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut nudged_until: i64 = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(TICK_SECS)).await;
            let now = now_ms();

            // 1. Wake snoozed threads.
            let woken = db.read(move |conn| repo::snoozes::woken(conn, now)).await;
            if let Ok(woken) = woken {
                for thread_id in woken {
                    let res = db
                        .write(move |conn| {
                            repo::snoozes::clear(conn, thread_id)?;
                            // Mark latest message unread so the thread pops.
                            conn.execute(
                                "UPDATE messages SET is_read = 0 WHERE id =
                                   (SELECT id FROM messages WHERE thread_id = ?1
                                    ORDER BY date DESC LIMIT 1)",
                                rusqlite::params![thread_id],
                            )?;
                            repo::threads::recompute(conn, thread_id)?;
                            Ok(())
                        })
                        .await;
                    if res.is_ok() {
                        bus.emit(CoreEvent::ThreadWoke { thread_id });
                    }
                }
            }

            // 2. Nudge actors when a timed pending action becomes due.
            if let Ok(Some(due_at)) = db.read(|conn| repo::actions::next_due_at(conn)).await {
                if due_at <= now && due_at > nudged_until - 60_000 {
                    nudged_until = now;
                    for handle in handles.read().await.values() {
                        handle.send(SyncCmd::RunActions);
                    }
                }
            }
        }
    })
}
