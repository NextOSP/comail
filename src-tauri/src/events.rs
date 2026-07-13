//! Forwards CoreEvents to the frontend as Tauri events, coalescing
//! mail:updated bursts (100ms) so sync storms don't thrash the UI.

use comail_core::events::CoreEvent;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;

pub fn spawn_forwarder(app: AppHandle, mut rx: broadcast::Receiver<CoreEvent>) {
    tauri::async_runtime::spawn(async move {
        let mut pending_updated: Vec<i64> = Vec::new();
        loop {
            let ev = if pending_updated.is_empty() {
                match rx.recv().await {
                    Ok(ev) => Some(ev),
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            } else {
                // Debounce window for mail:updated coalescing.
                match tokio::time::timeout(std::time::Duration::from_millis(100), rx.recv()).await {
                    Ok(Ok(ev)) => Some(ev),
                    Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                    Ok(Err(broadcast::error::RecvError::Closed)) => break,
                    Err(_) => None, // window elapsed
                }
            };

            match ev {
                Some(CoreEvent::MailUpdated { mut thread_ids }) => {
                    pending_updated.append(&mut thread_ids);
                    continue;
                }
                Some(other) => emit(&app, other),
                None => {}
            }

            if !pending_updated.is_empty() {
                pending_updated.sort_unstable();
                pending_updated.dedup();
                let ids = std::mem::take(&mut pending_updated);
                let _ = app.emit("mail:updated", json!({ "threadIds": ids }));
            }
        }
    });
}

fn emit(app: &AppHandle, ev: CoreEvent) {
    match ev {
        CoreEvent::SyncProgress(p) => {
            let _ = app.emit("sync:progress", &p);
        }
        CoreEvent::SyncStatus(status) => {
            let _ = app.emit("sync:status", &status);
        }
        CoreEvent::MailNew {
            account_id,
            thread_ids,
        } => {
            let _ = app.emit(
                "mail:new",
                json!({ "accountId": account_id, "threadIds": thread_ids }),
            );
        }
        CoreEvent::ActionState {
            action_id,
            state,
            error,
        } => {
            let _ = app.emit(
                "action:state",
                json!({ "actionId": action_id, "state": state, "error": error }),
            );
        }
        CoreEvent::ThreadWoke { thread_id } => {
            let _ = app.emit("thread:woke", json!({ "threadId": thread_id }));
        }
        CoreEvent::NetworkState { online } => {
            let _ = app.emit("network:state", json!({ "online": online }));
        }
        CoreEvent::AccountState {
            account_id,
            sync_state,
        } => {
            let _ = app.emit(
                "account:state",
                json!({ "accountId": account_id, "syncState": sync_state }),
            );
        }
        CoreEvent::MailUpdated { thread_ids } => {
            let _ = app.emit("mail:updated", json!({ "threadIds": thread_ids }));
        }
        CoreEvent::AskCitations {
            request_id,
            citations,
        } => {
            let _ = app.emit(
                "ai:ask:citations",
                json!({ "requestId": request_id, "citations": citations }),
            );
        }
        CoreEvent::AskDelta { request_id, delta } => {
            let _ = app.emit(
                "ai:ask:token",
                json!({ "requestId": request_id, "delta": delta }),
            );
        }
        CoreEvent::AskReasoning { request_id, delta } => {
            let _ = app.emit(
                "ai:ask:reasoning",
                json!({ "requestId": request_id, "delta": delta }),
            );
        }
        CoreEvent::AskDone { request_id } => {
            let _ = app.emit("ai:ask:done", json!({ "requestId": request_id }));
        }
        CoreEvent::CalendarUpdated { account_id } => {
            let _ = app.emit("calendar:updated", json!({ "accountId": account_id }));
        }
        CoreEvent::CalendarEventsAdded { account_id, events } => {
            let _ = app.emit(
                "calendar:new",
                json!({ "accountId": account_id, "events": events }),
            );
        }
        CoreEvent::EventReminder {
            event,
            occurrence_start,
        } => {
            let _ = app.emit(
                "calendar:reminder",
                json!({ "event": event, "occurrenceStart": occurrence_start }),
            );
        }
        CoreEvent::CalendarConflict { event_id, summary } => {
            let _ = app.emit(
                "calendar:conflict",
                json!({ "eventId": event_id, "summary": summary }),
            );
        }
    }
}
