//! Wakes snoozed threads and nudges account actors when timed actions
//! (send-later, undo-send windows) come due. Timers are app-local: anything
//! past due fires on the next tick or at launch.

use crate::db::Db;
use crate::db::repo;
use crate::events::{CoreEvent, EventBus};
use crate::models::now_ms;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::caldav::task::CalTaskHandle;
use crate::sync::engine::{AccountHandle, SyncCmd};

const TICK_SECS: u64 = 5;

pub fn spawn(
    db: Db,
    bus: EventBus,
    handles: Arc<RwLock<HashMap<i64, AccountHandle>>>,
    cal_handles: Arc<RwLock<HashMap<i64, CalTaskHandle>>>,
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
                    for handle in cal_handles.read().await.values() {
                        handle.nudge();
                    }
                }
            }

            // 3. Meeting reminders: fire once per occurrence inside the lead
            // window. Recurring events are covered because list_events
            // expansion is not needed here - the notified_at gate compares
            // against each occurrence start via upcoming_for_notify + the
            // expander below for recurring masters.
            let lead_min = db
                .read(|conn| Ok(repo::settings::get(conn)?.meeting_notify_lead_minutes))
                .await
                .unwrap_or(0);
            if lead_min > 0 {
                let lead_ms = lead_min * 60_000;
                if let Ok(due) = db
                    .read(move |conn| repo::calendar::upcoming_for_notify(conn, now, lead_ms))
                    .await
                {
                    for ev in due {
                        let event_id = ev.id;
                        let occurrence_start = ev.starts_at;
                        let _ = db
                            .write(move |conn| {
                                repo::calendar::set_notified(conn, event_id, occurrence_start)
                            })
                            .await;
                        bus.emit(CoreEvent::EventReminder {
                            event: ev,
                            occurrence_start,
                        });
                    }
                }
                // Recurring masters: check the next occurrence explicitly.
                if let Ok(masters) = db
                    .read(move |conn| repo::calendar::recurring_masters(conn, now + lead_ms))
                    .await
                {
                    for m in masters {
                        // Same gates as upcoming_for_notify: cancelled series
                        // (incl. CANCEL tombstones) and declined invites are
                        // silent.
                        if m.event.status.as_deref() == Some("CANCELLED")
                            || m.event.rsvp_status.as_deref() == Some("DECLINED")
                        {
                            continue;
                        }
                        let Some(rrule) = m.event.rrule.clone() else {
                            continue;
                        };
                        let duration = m
                            .event
                            .ends_at
                            .map(|e| e - m.event.starts_at)
                            .unwrap_or(1_800_000);
                        let Some(occs) = crate::caldav::rrule::expand(
                            &rrule,
                            m.event.starts_at,
                            duration,
                            m.ical_raw.as_deref(),
                            now,
                            now + lead_ms,
                        ) else {
                            continue;
                        };
                        let Some(next) = occs.first().copied() else {
                            continue;
                        };
                        // Gate: skip when this occurrence was already notified,
                        // and never re-notify the master's own start (handled
                        // by upcoming_for_notify above).
                        let already = db
                            .read({
                                let id = m.event.id;
                                move |conn| {
                                    Ok(conn.query_row(
                                        "SELECT COALESCE(notified_at, 0) FROM calendar_events WHERE id = ?1",
                                        rusqlite::params![id],
                                        |r| r.get::<_, i64>(0),
                                    )?)
                                }
                            })
                            .await
                            .unwrap_or(i64::MAX);
                        if already >= next.start || next.start <= m.event.starts_at {
                            continue;
                        }
                        let event_id = m.event.id;
                        let _ = db
                            .write(move |conn| {
                                repo::calendar::set_notified(conn, event_id, next.start)
                            })
                            .await;
                        let mut ev = m.event.clone();
                        ev.starts_at = next.start;
                        ev.ends_at = Some(next.end);
                        bus.emit(CoreEvent::EventReminder {
                            event: ev,
                            occurrence_start: next.start,
                        });
                    }
                }
            }
        }
    })
}
