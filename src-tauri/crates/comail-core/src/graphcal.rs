//! Microsoft 365 calendar sync over Graph. Outlook.com and Microsoft 365
//! expose no CalDAV endpoint, so Microsoft accounts sync their calendar via
//! the Graph API instead: push local dirty rows first (create/patch/delete),
//! then an incremental calendarView delta pull per enabled calendar, sharing
//! the CalDAV task loop, tables and event bus.
//!
//! calendarView expands recurring series into occurrences server-side, so no
//! RRULE handling happens here: each occurrence is stored as its own row
//! (rrule stays NULL and the local expander skips them). The delta link is
//! kept in the calendar's `sync_token` column; a `410 Gone` restarts from a
//! fresh window.

use crate::calendar::{IcsAttendee, IcsEvent};
use crate::db::Db;
use crate::db::repo;
use crate::db::repo::calendar::SyncRow;
use crate::error::{CoreError, Result};
use crate::events::{CoreEvent, EventBus, NewEventInfo};
use crate::graph;
use crate::models::{Provider, now_ms};
use crate::oauth::tokens::TokenProvider;

/// Delta windows are fixed at first sync: 90 days back, ~13 months ahead.
/// Events outside the window arrive when the token eventually expires (410)
/// and the window is re-anchored to "now".
const WINDOW_PAST_MS: i64 = 90 * 86_400_000;
const WINDOW_FUTURE_MS: i64 = 400 * 86_400_000;

/// One account's full Graph calendar cycle. Returns true when anything
/// changed, mirroring `caldav::sync::sync_account`.
pub async fn sync_account(
    db: &Db,
    bus: &EventBus,
    tokens: &TokenProvider,
    account_id: i64,
) -> Result<bool> {
    let token = tokens
        .access_token_for_scope(
            account_id,
            Provider::Microsoft,
            crate::oauth::providers::MS_CALENDARS_SCOPE,
        )
        .await?;

    // Local changes first, so the pull sees (and agrees with) their results.
    let pushed = push_dirty(db, &token, account_id).await?;

    let calendars = db
        .read(move |conn| repo::caldav::list_calendars(conn, Some(account_id)))
        .await?;
    let mut changed_any = pushed;
    let mut new_events: Vec<NewEventInfo> = Vec::new();

    for cal in calendars.into_iter().filter(|c| c.enabled) {
        match sync_calendar(db, &token, account_id, cal.id, &cal.url).await {
            Ok((changed, fresh)) => {
                changed_any |= changed;
                new_events.extend(fresh);
            }
            Err(CoreError::NeedsReauth) => return Err(CoreError::NeedsReauth),
            Err(e) => {
                tracing::warn!("graph calendar {} sync failed: {e}", cal.id);
                let msg = e.to_string();
                db.write(move |conn| repo::caldav::set_config_error(conn, account_id, Some(&msg)))
                    .await?;
            }
        }
    }

    if changed_any {
        bus.emit(CoreEvent::CalendarUpdated { account_id });
    }
    if !new_events.is_empty() {
        bus.emit(CoreEvent::CalendarEventsAdded {
            account_id,
            events: new_events,
        });
    }
    Ok(changed_any)
}

/// Push every dirty/tombstoned row via Graph. Updates are unconditional
/// PATCHes (Graph offers no If-Match on delegated events), so concurrent
/// remote edits resolve last-writer-wins; the next pull reconciles the row.
async fn push_dirty(db: &Db, token: &str, account_id: i64) -> Result<bool> {
    let rows = db
        .read(move |conn| repo::calendar::dirty_rows(conn, account_id))
        .await?;
    let mut any = false;
    for row in rows {
        match push_row(db, token, account_id, &row).await {
            Ok(()) => any = true,
            Err(CoreError::NeedsReauth) => return Err(CoreError::NeedsReauth),
            Err(e) => tracing::warn!("graph push of event {} failed: {e}", row.event.id),
        }
    }
    Ok(any)
}

async fn push_row(db: &Db, token: &str, account_id: i64, row: &SyncRow) -> Result<()> {
    let event_id = row.event.id;
    if row.deleted {
        if let Some(href) = &row.caldav_href {
            graph::delete_calendar_event(token, href).await?;
        }
        db.write(move |conn| repo::calendar::hard_delete(conn, event_id))
            .await?;
        return Ok(());
    }

    let subject = row.event.summary.clone().unwrap_or_default();
    let ev = graph_event(&subject, &row.event);
    match &row.caldav_href {
        Some(href) => {
            graph::update_calendar_event(token, href, &ev).await?;
            let calendar_id = match row.event.calendar_id {
                Some(id) => id,
                None => return Err(CoreError::CalDav("synced event without calendar".into())),
            };
            let href = href.clone();
            db.write(move |conn| {
                repo::calendar::clear_dirty_set_etag(conn, event_id, calendar_id, &href, None, "")
            })
            .await?;
        }
        None => {
            let default = db
                .read(move |conn| repo::caldav::default_calendar(conn, account_id))
                .await?
                .ok_or_else(|| CoreError::CalDav("no calendar to write to".into()))?;
            let id = graph::create_calendar_event(token, Some(&default.url), &ev).await?;
            if id.is_empty() {
                return Err(CoreError::Other("graph create returned no event id".into()));
            }
            let calendar_id = default.id;
            db.write(move |conn| {
                repo::calendar::clear_dirty_set_etag(conn, event_id, calendar_id, &id, None, "")
            })
            .await?;
        }
    }
    Ok(())
}

fn graph_event<'a>(
    subject: &'a str,
    ev: &'a crate::models::CalendarEvent,
) -> graph::GraphEvent<'a> {
    // Fold the join link into the body so it survives in Outlook/Teams.
    let body_html = match (&ev.description, &ev.join_url) {
        (d, Some(url)) => Some(format!(
            "{}<p><a href=\"{}\">Join the meeting</a></p>",
            d.as_deref().unwrap_or(""),
            url
        )),
        (Some(d), None) if !d.trim().is_empty() => Some(d.clone()),
        _ => None,
    };
    graph::GraphEvent {
        subject,
        body_html,
        location: ev.location.as_deref(),
        start_ms: ev.starts_at,
        end_ms: ev.ends_at.unwrap_or(ev.starts_at + 1_800_000),
        all_day: ev.all_day,
        attendees: ev
            .attendees
            .iter()
            .map(|a| graph::GraphAttendee {
                email: a.email.clone(),
                name: a.name.clone(),
            })
            .collect(),
    }
}

async fn sync_calendar(
    db: &Db,
    token: &str,
    account_id: i64,
    calendar_id: i64,
    graph_cal_id: &str,
) -> Result<(bool, Vec<NewEventInfo>)> {
    let (_, stored_token) = db
        .read(move |conn| repo::caldav::sync_state(conn, calendar_id))
        .await?;

    // Only an incremental pull yields genuinely-new events worth announcing;
    // the initial (or re-anchored) full pull inserts the whole window.
    let mut incremental = stored_token.is_some();
    let now = now_ms();
    let fresh_url = || graph::delta_url(graph_cal_id, now - WINDOW_PAST_MS, now + WINDOW_FUTURE_MS);
    let mut url = match stored_token {
        Some(link) => link,
        None => fresh_url()?,
    };

    let mut restarted = false;
    let mut changed_any = false;
    let mut new_events: Vec<NewEventInfo> = Vec::new();
    let delta_link: Option<String>;

    loop {
        let Some(page) = graph::delta_page(token, &url).await? else {
            // 410 Gone: the delta token expired, re-anchor the window once.
            if restarted {
                return Err(CoreError::CalDav("graph delta restarted twice".into()));
            }
            restarted = true;
            incremental = false;
            url = fresh_url()?;
            continue;
        };

        let (removed, upserts): (Vec<_>, Vec<_>) = page.events.into_iter().partition(|e| e.removed);

        if !upserts.is_empty() {
            changed_any = true;
            let batch_new = db
                .write(move |conn| {
                    let tx = conn.transaction()?;
                    let mut fresh: Vec<NewEventInfo> = Vec::new();
                    for ev in &upserts {
                        if ev.start_ms == 0 || ev.event_type.as_deref() == Some("seriesMaster") {
                            continue;
                        }
                        let ics = ics_event(ev);
                        let inserted = repo::calendar::upsert_remote(
                            &tx,
                            account_id,
                            calendar_id,
                            &ev.id,
                            ev.etag.as_deref().unwrap_or(""),
                            "",
                            &ics,
                        )?;
                        if inserted {
                            fresh.push(NewEventInfo {
                                summary: ics.summary.clone(),
                                starts_at: ics.starts_at_ms,
                                all_day: ics.all_day,
                            });
                        }
                    }
                    tx.commit()?;
                    Ok(fresh)
                })
                .await?;
            new_events.extend(batch_new);
        }

        if !removed.is_empty() {
            changed_any = true;
            db.write(move |conn| {
                let tx = conn.transaction()?;
                for ev in &removed {
                    repo::calendar::delete_by_href(&tx, calendar_id, &ev.id)?;
                }
                tx.commit()?;
                Ok(())
            })
            .await?;
        }

        match page.next_link {
            Some(next) => url = next,
            None => {
                delta_link = page.delta_link;
                break;
            }
        }
    }

    if !incremental {
        new_events.clear();
    }

    let synced_at = now_ms();
    db.write(move |conn| {
        repo::caldav::set_sync_state(conn, calendar_id, None, delta_link.as_deref(), synced_at)
    })
    .await?;
    Ok((changed_any, new_events))
}

/// Map a Graph delta event onto the shared calendar row shape. Occurrences
/// and exceptions of a series all share one iCalUId, so their local uid is
/// the (unique) Graph id instead - only single instances keep the iCalUId,
/// which lets the row adopt an earlier mail-invite copy of the same event.
fn ics_event(ev: &graph::DeltaEvent) -> IcsEvent {
    let uid = match ev.event_type.as_deref() {
        Some("singleInstance") | None => ev.ical_uid.clone().unwrap_or_else(|| ev.id.clone()),
        _ => ev.id.clone(),
    };
    IcsEvent {
        uid,
        method: None,
        summary: ev.subject.clone(),
        location: ev.location.clone(),
        organizer: ev.organizer_email.clone(),
        description: ev.body_preview.clone(),
        attendees: ev
            .attendees
            .iter()
            .map(|(email, name, partstat)| IcsAttendee {
                email: email.clone(),
                name: name.clone(),
                partstat: partstat.clone(),
            })
            .collect(),
        join_url: ev.join_url.clone(),
        sequence: 0,
        rrule: None,
        tzid: None,
        recurrence_id_ms: None,
        starts_at_ms: ev.start_ms,
        ends_at_ms: ev.end_ms,
        all_day: ev.all_day,
        status: Some(
            if ev.cancelled {
                "CANCELLED"
            } else {
                "CONFIRMED"
            }
            .to_string(),
        ),
    }
}
