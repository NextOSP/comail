//! Core events broadcast to the host (the Tauri layer forwards them to the UI).

use serde::Serialize;
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub account_id: i64,
    pub folder: String,
    pub phase: String, // folders|headers|bodies|history|idle
    pub done: u64,
    pub total: u64,
}

/// Minimal description of an event the pull just discovered, enough for a
/// "new event" desktop notification without shipping the whole row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEventInfo {
    pub summary: Option<String>,
    pub starts_at: i64,
    pub all_day: bool,
}

#[derive(Debug, Clone)]
pub enum CoreEvent {
    SyncProgress(SyncProgress),
    MailNew {
        account_id: i64,
        thread_ids: Vec<i64>,
    },
    MailUpdated {
        thread_ids: Vec<i64>,
    },
    ActionState {
        action_id: i64,
        state: String,
        error: Option<String>,
    },
    ThreadWoke {
        thread_id: i64,
    },
    NetworkState {
        online: bool,
    },
    AccountState {
        account_id: i64,
        sync_state: String,
    },
    /// RAG "ask" retrieved its source messages (emitted before the answer
    /// streams, so the UI can show sources immediately).
    AskCitations {
        request_id: String,
        citations: Vec<crate::models::AskCitation>,
    },
    /// One incremental chunk of the streamed "ask" answer.
    AskDelta {
        request_id: String,
        delta: String,
    },
    /// The streamed "ask" answer finished.
    AskDone {
        request_id: String,
    },
    /// Calendar data changed (CalDAV pull or local mutation synced).
    CalendarUpdated {
        account_id: i64,
    },
    /// New events the incremental CalDAV pull discovered (not initial backfill),
    /// for a "new event" notification.
    CalendarEventsAdded {
        account_id: i64,
        events: Vec<NewEventInfo>,
    },
    /// A meeting starts within the reminder window.
    EventReminder {
        event: crate::models::CalendarEvent,
        occurrence_start: i64,
    },
    /// A local edit lost against the server (kept as a conflict copy).
    CalendarConflict {
        event_id: i64,
        summary: Option<String>,
    },
}

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<CoreEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(1024);
        EventBus { tx }
    }

    pub fn emit(&self, ev: CoreEvent) {
        // Nobody listening is fine (e.g. during tests).
        let _ = self.tx.send(ev);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CoreEvent> {
        self.tx.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}
