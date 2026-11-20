//! Per-account CardDAV task, the contacts twin of `caldav::task`: an
//! HTTP-only loop separate from the IMAP actor that wakes every POLL_SECS or
//! when nudged (connect, "Sync now", an address book switched back on).

use std::time::Duration;

use tokio::sync::mpsc;

use crate::accounts::credentials::{self, Slot};
use crate::caldav::{DavAuth, HttpTransport};
use crate::db::Db;
use crate::db::repo;
use crate::error::{CoreError, Result};
use crate::events::{CoreEvent, EventBus};
use crate::models::now_ms;

use super::sync::sync_account;

const POLL_SECS: u64 = 300;

#[derive(Clone)]
pub struct ContactsTaskHandle {
    pub account_id: i64,
    tx: mpsc::UnboundedSender<()>,
}

impl ContactsTaskHandle {
    pub fn nudge(&self) {
        let _ = self.tx.send(());
    }
}

pub fn spawn(db: Db, bus: EventBus, account_id: i64) -> ContactsTaskHandle {
    let (tx, mut rx) = mpsc::unbounded_channel::<()>();
    let handle = ContactsTaskHandle { account_id, tx };
    tokio::spawn(async move {
        loop {
            let woke = tokio::select! {
                m = rx.recv() => m.is_some(),
                _ = tokio::time::sleep(Duration::from_secs(POLL_SECS)) => true,
            };
            if !woke {
                break; // handle dropped: account removed / contacts disconnected
            }
            // Drain coalesced nudges.
            while rx.try_recv().is_ok() {}
            run_cycle(&db, &bus, account_id).await;
        }
        tracing::debug!("carddav task for account {account_id} stopped");
    });
    handle
}

/// Basic-auth transport from the stored config and keyring password.
async fn transport_for(db: &Db, account_id: i64) -> Result<Option<HttpTransport>> {
    let cfg = db
        .read(move |conn| repo::carddav::get_config(conn, account_id))
        .await?;
    let Some(cfg) = cfg.filter(|c| c.enabled) else {
        return Ok(None);
    };
    let user = cfg.username.unwrap_or_default();
    let pass = credentials::load_async(account_id, Slot::CarddavPassword).await?;
    Ok(Some(HttpTransport::new(DavAuth::Basic(user, pass))?))
}

/// One pull; records its outcome on the config row and tells the UI.
async fn run_cycle(db: &Db, bus: &EventBus, account_id: i64) {
    let transport = match transport_for(db, account_id).await {
        Ok(Some(t)) => t,
        Ok(None) => return,
        Err(e) => {
            record(db, bus, account_id, Some(e.to_string()), false).await;
            return;
        }
    };
    let (error, changed) = match sync_account(db, &transport, account_id).await {
        Ok(outcome) => (
            (!outcome.errors.is_empty()).then(|| outcome.errors.join("; ")),
            outcome.changed,
        ),
        Err(CoreError::NeedsReauth) => (Some("needs_reauth".to_string()), false),
        Err(e) => {
            tracing::warn!("carddav cycle for account {account_id} failed: {e}");
            (Some(e.to_string()), false)
        }
    };
    record(db, bus, account_id, error, changed).await;
}

async fn record(db: &Db, bus: &EventBus, account_id: i64, error: Option<String>, changed: bool) {
    let synced_at = error.is_none().then(now_ms);
    let _ = db
        .write(move |conn| repo::carddav::set_status(conn, account_id, error.as_deref(), synced_at))
        .await;
    bus.emit(CoreEvent::ContactsUpdated {
        account_id,
        changed,
    });
}
