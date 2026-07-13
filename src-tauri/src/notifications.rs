//! Durable native desktop-notification delivery.
//!
//! Sync owns eligibility and enqueues an immutable presentation snapshot in
//! SQLite. This host-side worker is deliberately independent of the webview so
//! tray-hidden windows and temporarily unmounted frontend listeners cannot lose
//! notifications.

use comail_core::{Core, NotificationOutboxItem};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;
use tokio::time::MissedTickBehavior;

const POLL_INTERVAL: Duration = Duration::from_secs(3);
const DISPATCH_BATCH: i64 = 16;
const MAX_RETRY_DELAY_MS: i64 = 5 * 60 * 1_000;

/// Start the single notification dispatcher for this app process.
pub fn spawn_dispatcher(app: AppHandle, core: Core) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = core.recover_notification_deliveries().await {
            tracing::warn!(%error, "notification outbox recovery failed");
        }

        let mut tick = tokio::time::interval(POLL_INTERVAL);
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            dispatch_due(&app, &core).await;
        }
    });
}

async fn dispatch_due<R: Runtime>(app: &AppHandle<R>, core: &Core) {
    let notifications_enabled = match core.get_settings().await {
        Ok(settings) => settings.notifications_enabled,
        Err(error) => {
            tracing::warn!(%error, "notification dispatcher could not read settings");
            return;
        }
    };
    let due = match core.due_notifications(DISPATCH_BATCH).await {
        Ok(due) => due,
        Err(error) => {
            tracing::warn!(%error, "notification dispatcher could not read outbox");
            return;
        }
    };

    for item in due {
        match core.claim_notification_delivery(item.id).await {
            Ok(true) => {}
            Ok(false) => continue,
            Err(error) => {
                tracing::warn!(outbox_id = item.id, %error, "notification claim failed");
                continue;
            }
        }

        if !notifications_enabled {
            suppress(core, item.id, "notifications disabled").await;
            continue;
        }
        if main_window_is_active(app) {
            suppress(core, item.id, "main window active").await;
            continue;
        }

        let (title, body) = notification_copy(&item);
        match app.notification().builder().title(title).body(body).show() {
            Ok(()) => match core.mark_notification_delivered(item.id).await {
                Ok(true) => {}
                Ok(false) => tracing::warn!(
                    outbox_id = item.id,
                    "native notification sent but outbox state was no longer claimable"
                ),
                Err(error) => tracing::warn!(
                    outbox_id = item.id,
                    %error,
                    "native notification sent but delivery state could not be persisted"
                ),
            },
            Err(error) => {
                let delay_ms = retry_delay_ms(item.attempts.saturating_add(1));
                tracing::warn!(
                    outbox_id = item.id,
                    attempts = item.attempts.saturating_add(1),
                    delay_ms,
                    %error,
                    "native notification failed; scheduled retry"
                );
                if let Err(db_error) = core
                    .retry_notification_delivery(item.id, delay_ms, error.to_string())
                    .await
                {
                    tracing::warn!(
                        outbox_id = item.id,
                        %db_error,
                        "notification retry state could not be persisted"
                    );
                }
            }
        }
    }
}

async fn suppress(core: &Core, id: i64, reason: &'static str) {
    match core.suppress_notification_delivery(id, reason).await {
        Ok(true) => {}
        Ok(false) => tracing::warn!(outbox_id = id, reason, "notification suppression lost race"),
        Err(error) => {
            tracing::warn!(outbox_id = id, reason, %error, "notification suppression failed")
        }
    }
}

/// A visible-but-background window still needs a banner. Suppress only when
/// the user is actively looking at Comail.
fn main_window_is_active<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
}

fn notification_copy(item: &NotificationOutboxItem) -> (String, String) {
    let title = nonempty(item.sender_name.as_deref())
        .or_else(|| nonempty(item.sender_addr.as_deref()))
        .unwrap_or("Comail")
        .to_owned();
    let body = nonempty(Some(&item.subject))
        .unwrap_or("New message")
        .to_owned();
    (title, body)
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// Exponential retry beginning at five seconds and capped at five minutes.
fn retry_delay_ms(attempt: i64) -> i64 {
    let exponent = attempt.saturating_sub(1).clamp(0, 6) as u32;
    (5_000_i64.saturating_mul(1_i64 << exponent)).min(MAX_RETRY_DELAY_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: Option<&str>, address: Option<&str>, subject: &str) -> NotificationOutboxItem {
        NotificationOutboxItem {
            id: 1,
            account_id: 2,
            message_id: 3,
            thread_id: Some(4),
            sender_name: name.map(str::to_owned),
            sender_addr: address.map(str::to_owned),
            subject: subject.to_owned(),
            state: "pending".to_owned(),
            attempts: 0,
            not_before: None,
            created_at: 0,
            claimed_at: None,
            delivered_at: None,
            suppressed_at: None,
            suppression_reason: None,
            last_error: None,
        }
    }

    #[test]
    fn copy_prefers_name_then_address_and_has_safe_fallbacks() {
        assert_eq!(
            notification_copy(&item(Some(" Alice "), Some("alice@test.dev"), " Hi ")),
            ("Alice".to_owned(), "Hi".to_owned())
        );
        assert_eq!(
            notification_copy(&item(Some(" "), Some(" alice@test.dev "), "")),
            ("alice@test.dev".to_owned(), "New message".to_owned())
        );
        assert_eq!(
            notification_copy(&item(None, None, "Subject")),
            ("Comail".to_owned(), "Subject".to_owned())
        );
    }

    #[test]
    fn retry_backoff_is_bounded() {
        assert_eq!(retry_delay_ms(1), 5_000);
        assert_eq!(retry_delay_ms(2), 10_000);
        assert_eq!(retry_delay_ms(5), 80_000);
        assert_eq!(retry_delay_ms(7), MAX_RETRY_DELAY_MS);
        assert_eq!(retry_delay_ms(100), MAX_RETRY_DELAY_MS);
    }
}
