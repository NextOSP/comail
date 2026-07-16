//! Durable native desktop-notification delivery.
//!
//! Sync owns eligibility and enqueues an immutable presentation snapshot in
//! SQLite. This host-side worker is deliberately independent of the webview so
//! tray-hidden windows and temporarily unmounted frontend listeners cannot lose
//! notifications.

use comail_core::{Core, NotificationOutboxItem, RoutedTab};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;
use tokio::time::MissedTickBehavior;

const POLL_INTERVAL: Duration = Duration::from_secs(3);
const DISPATCH_BATCH: i64 = 16;
const MAX_RETRY_DELAY_MS: i64 = 5 * 60 * 1_000;
/// How long to hold a notification while its thread awaits AI routing before
/// giving up and delivering anyway (better to over-notify than lose mail).
const MAX_ROUTING_WAIT_MS: i64 = 30_000;
/// How far out a still-routing notification is deferred between re-checks.
const ROUTING_RECHECK_MS: i64 = 3_000;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// What to do with one due notification once the user's scope is applied.
enum Decision {
    Deliver,
    /// Wait for the thread's tab to resolve; re-check at this epoch-ms.
    Defer(i64),
    Suppress(&'static str),
}

/// Whether a resolved route key passes the configured notification scope.
/// `"all"` lets everything through; `"tabs"` matches the selected route keys;
/// any other value (including the default `"important"`) keeps the historical
/// Important-only behavior.
fn scope_allows(scope: &str, tabs: &[String], routed_key: &str) -> bool {
    match scope {
        "all" => true,
        "tabs" => tabs.iter().any(|t| t == routed_key),
        _ => routed_key == "important",
    }
}

/// Decide one item's fate without claiming it, so a wait-for-routing deferral
/// never consumes a delivery attempt.
async fn delivery_decision(
    core: &Core,
    item: &NotificationOutboxItem,
    scope: &str,
    tabs: &[String],
    now: i64,
) -> Decision {
    // "all" needs no tab lookup at all.
    if scope == "all" {
        return Decision::Deliver;
    }
    let Some(thread_id) = item.thread_id else {
        // Nothing to scope against; fail open rather than drop it.
        return Decision::Deliver;
    };
    match core.notification_thread_tab(thread_id).await {
        Ok(Some(RoutedTab::Resolved(key))) => {
            if scope_allows(scope, tabs, &key) {
                Decision::Deliver
            } else {
                Decision::Suppress("out of notification scope")
            }
        }
        Ok(Some(RoutedTab::Pending)) => {
            if now - item.created_at < MAX_ROUTING_WAIT_MS {
                Decision::Defer(now + ROUTING_RECHECK_MS)
            } else {
                Decision::Deliver
            }
        }
        Ok(None) => Decision::Suppress("thread no longer present"),
        Err(error) => {
            tracing::warn!(outbox_id = item.id, %error, "notification tab lookup failed");
            // Don't lose a notification over a transient read error.
            Decision::Deliver
        }
    }
}

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
    let settings = match core.get_settings().await {
        Ok(settings) => settings,
        Err(error) => {
            tracing::warn!(%error, "notification dispatcher could not read settings");
            return;
        }
    };
    let notifications_enabled = settings.notifications_enabled;
    let scope = settings.notification_scope;
    let tabs = settings.notification_tabs;
    let due = match core.due_notifications(DISPATCH_BATCH).await {
        Ok(due) => due,
        Err(error) => {
            tracing::warn!(%error, "notification dispatcher could not read outbox");
            return;
        }
    };

    for item in due {
        // Master switch off: claim and suppress so the row reaches a terminal
        // state instead of being re-listed every cycle.
        if !notifications_enabled {
            if core
                .claim_notification_delivery(item.id)
                .await
                .unwrap_or(false)
            {
                suppress(core, item.id, "notifications disabled").await;
            }
            continue;
        }

        // Apply the user's scope before claiming, so waiting for a thread's tab
        // to resolve never consumes a delivery attempt.
        match delivery_decision(core, &item, &scope, &tabs, now_ms()).await {
            Decision::Deliver => {}
            Decision::Defer(not_before) => {
                if let Err(error) = core.defer_notification_delivery(item.id, not_before).await {
                    tracing::warn!(outbox_id = item.id, %error, "notification defer failed");
                }
                continue;
            }
            Decision::Suppress(reason) => {
                if core
                    .claim_notification_delivery(item.id)
                    .await
                    .unwrap_or(false)
                {
                    suppress(core, item.id, reason).await;
                }
                continue;
            }
        }

        match core.claim_notification_delivery(item.id).await {
            Ok(true) => {}
            Ok(false) => continue,
            Err(error) => {
                tracing::warn!(outbox_id = item.id, %error, "notification claim failed");
                continue;
            }
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
    fn scope_gates_by_routed_tab() {
        let tabs = vec!["important".to_owned(), "split:3".to_owned()];

        // "all" ignores the tab entirely.
        assert!(scope_allows("all", &[], "other"));
        assert!(scope_allows("all", &[], "label:9"));

        // "tabs" matches only the selected route keys.
        assert!(scope_allows("tabs", &tabs, "important"));
        assert!(scope_allows("tabs", &tabs, "split:3"));
        assert!(!scope_allows("tabs", &tabs, "other"));
        assert!(!scope_allows("tabs", &tabs, "split:4"));

        // The default (and any unknown value) is Important-only.
        assert!(scope_allows("important", &tabs, "important"));
        assert!(!scope_allows("important", &tabs, "other"));
        assert!(!scope_allows("", &tabs, "other"));
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
