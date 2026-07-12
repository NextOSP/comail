//! Push local changes to the server: PUT with If-Match (edit) or
//! If-None-Match:* (create), DELETE with If-Match. Conflict policy on 412:
//! the server wins - its copy replaces the local row and the user's edit is
//! preserved as a detached local-only duplicate (nobody is emailed).

use crate::calendar::{escape, fmt_utc, fold, parse_ics, push_prop};
use crate::db::repo;
use crate::db::repo::calendar::SyncRow;
use crate::db::Db;
use crate::error::{CoreError, Result};
use crate::events::{CoreEvent, EventBus};
use crate::models::now_ms;

use super::Transport;

/// Push every dirty/tombstoned row of the account. Individual row failures
/// are logged and left dirty for the next cycle; only auth errors abort.
/// Returns true when at least one row synced.
pub async fn push_dirty(
    db: &Db,
    bus: &EventBus,
    t: &dyn Transport,
    account_id: i64,
) -> Result<bool> {
    let rows = db
        .read(move |conn| repo::calendar::dirty_rows(conn, account_id))
        .await?;
    let mut any = false;
    for row in rows {
        match push_row(db, bus, t, account_id, &row).await {
            Ok(()) => any = true,
            Err(CoreError::NeedsReauth) => return Err(CoreError::NeedsReauth),
            Err(CoreError::Offline) => return Err(CoreError::Offline),
            Err(e) => tracing::warn!("caldav push of event {} failed: {e}", row.event.id),
        }
    }
    Ok(any)
}

async fn push_row(
    db: &Db,
    bus: &EventBus,
    t: &dyn Transport,
    account_id: i64,
    row: &SyncRow,
) -> Result<()> {
    if row.deleted {
        return push_delete(db, t, row).await;
    }

    // Where does the resource live? Existing href, else the account's default
    // calendar gets a new <uid>.ics resource.
    let (calendar_id, href_path, if_match): (i64, String, Option<String>) =
        match (&row.event.calendar_id, &row.caldav_href) {
            (Some(cal), Some(href)) => (*cal, href.clone(), row.etag.clone()),
            _ => {
                let default = db
                    .read(move |conn| repo::caldav::default_calendar(conn, account_id))
                    .await?
                    .ok_or_else(|| super::err("no calendar collection to write to"))?;
                let path = match url::Url::parse(&default.url) {
                    Ok(u) => format!("{}{}.ics", u.path(), sanitize_uid(&row.ical_uid)),
                    Err(_) => format!("{}{}.ics", default.url, sanitize_uid(&row.ical_uid)),
                };
                (default.id, path, None)
            }
        };

    let cal_url = db
        .read(move |conn| repo::caldav::get_calendar(conn, calendar_id))
        .await?
        .ok_or_else(|| super::err("calendar collection missing"))?
        .url;
    let abs_url = super::discovery::resolve(&cal_url, &href_path)?;

    let self_email = db
        .read(move |conn| repo::accounts::get(conn, account_id))
        .await?
        .map(|a| a.email);
    let body = build_put_body(row, self_email.as_deref());

    let headers: Vec<(&str, &str)> = match &if_match {
        Some(etag) => vec![("If-Match", etag.as_str())],
        None => vec![("If-None-Match", "*")],
    };
    let mut resp = t
        .request("PUT", &abs_url, None, &headers, Some(body.clone()))
        .await?;
    // Some servers strip the body's Content-Type check; retry a 415 without
    // conditional headers is NOT done - but a 412 on create means the uid
    // already exists remotely: treat like an update conflict.
    if resp.status == 412 || resp.status == 409 {
        return resolve_conflict(
            db,
            bus,
            t,
            account_id,
            calendar_id,
            &abs_url,
            &href_path,
            row,
        )
        .await;
    }
    if !resp.ok() {
        return Err(super::err(format!("PUT {abs_url}: HTTP {}", resp.status)));
    }
    // Servers may omit the ETag on PUT; re-read it cheaply then.
    if resp.etag.is_none() {
        if let Ok(head) = t.request("HEAD", &abs_url, None, &[], None).await {
            resp.etag = head.etag;
        }
    }
    let event_id = row.event.id;
    let etag = resp.etag.clone();
    let href = href_path.clone();
    db.write(move |conn| {
        repo::calendar::clear_dirty_set_etag(
            conn,
            event_id,
            calendar_id,
            &href,
            etag.as_deref(),
            &body,
        )
    })
    .await?;
    Ok(())
}

async fn push_delete(db: &Db, t: &dyn Transport, row: &SyncRow) -> Result<()> {
    let event_id = row.event.id;
    let (Some(calendar_id), Some(href)) = (row.event.calendar_id, row.caldav_href.clone()) else {
        // Never synced: nothing to delete remotely.
        db.write(move |conn| repo::calendar::hard_delete(conn, event_id))
            .await?;
        return Ok(());
    };
    let cal_url = db
        .read(move |conn| repo::caldav::get_calendar(conn, calendar_id))
        .await?
        .ok_or_else(|| super::err("calendar collection missing"))?
        .url;
    let abs_url = super::discovery::resolve(&cal_url, &href)?;
    let headers: Vec<(&str, &str)> = match &row.etag {
        Some(etag) => vec![("If-Match", etag.as_str())],
        None => vec![],
    };
    let resp = t.request("DELETE", &abs_url, None, &headers, None).await?;
    match resp.status {
        s if (200..300).contains(&s) || s == 404 => {
            db.write(move |conn| repo::calendar::hard_delete(conn, event_id))
                .await?;
            Ok(())
        }
        412 => {
            // Server-side change since we tombstoned: server wins - undelete
            // locally, the next pull refreshes the row.
            db.write(move |conn| {
                conn.execute(
                    "UPDATE calendar_events SET deleted = 0, dirty = 0, status = NULL, etag = NULL
                     WHERE id = ?1",
                    rusqlite::params![event_id],
                )?;
                Ok(())
            })
            .await?;
            Ok(())
        }
        s => Err(super::err(format!("DELETE {abs_url}: HTTP {s}"))),
    }
}

/// 412/409 on PUT: fetch the server copy, replace the local row with it, and
/// keep the user's version as a detached local-only conflict copy.
#[allow(clippy::too_many_arguments)]
async fn resolve_conflict(
    db: &Db,
    bus: &EventBus,
    t: &dyn Transport,
    account_id: i64,
    calendar_id: i64,
    abs_url: &str,
    href_path: &str,
    row: &SyncRow,
) -> Result<()> {
    let server = t.request("GET", abs_url, None, &[], None).await?;
    let event_id = row.event.id;
    let summary = row.event.summary.clone();

    if server.ok() {
        let ics = server.body.clone();
        let etag = server.etag.clone().unwrap_or_default();
        let href = href_path.to_string();
        let row2 = row.clone();
        db.write(move |conn| {
            let tx = conn.transaction()?;
            // Preserve the user's edit as a new local-only event first.
            let conflict_uid = format!("{}-conflict-{}", row2.ical_uid, now_ms());
            let atts = row2.event.attendees.clone();
            repo::calendar::insert_local(
                &tx,
                account_id,
                &conflict_uid,
                &format!(
                    "{} (conflict copy)",
                    row2.event.summary.clone().unwrap_or_default()
                ),
                row2.event.location.as_deref(),
                row2.event.description.as_deref(),
                row2.event.join_url.as_deref(),
                row2.event.organizer.as_deref().unwrap_or_default(),
                &atts,
                row2.event.starts_at,
                row2.event
                    .ends_at
                    .unwrap_or(row2.event.starts_at + 1_800_000),
                row2.event.all_day,
            )?;
            // Then let the server version replace the original row.
            let events = parse_ics(&ics);
            if let Some(master) = events.iter().find(|e| e.recurrence_id_ms.is_none()) {
                tx.execute(
                    "UPDATE calendar_events SET dirty = 0, deleted = 0 WHERE id = ?1",
                    rusqlite::params![event_id],
                )?;
                repo::calendar::upsert_remote(
                    &tx,
                    account_id,
                    calendar_id,
                    &href,
                    &etag,
                    &ics,
                    master,
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await?;
    } else if server.status == 404 {
        // Conflict on a resource that then vanished: keep ours, retry as create.
        let event_id = row.event.id;
        db.write(move |conn| {
            conn.execute(
                "UPDATE calendar_events SET caldav_href = NULL, etag = NULL WHERE id = ?1",
                rusqlite::params![event_id],
            )?;
            Ok(())
        })
        .await?;
        return Ok(());
    }

    bus.emit(CoreEvent::CalendarConflict { event_id, summary });
    Ok(())
}

fn sanitize_uid(uid: &str) -> String {
    uid.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '@' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Serialize the row as a calendar object (no METHOD - servers reject
/// scheduling methods on plain PUTs). The master VEVENT is regenerated from
/// the row's fields; EXDATE lines, VALARM blocks and override VEVENTs are
/// carried over verbatim from the last known server copy.
pub fn build_put_body(row: &SyncRow, self_email: Option<&str>) -> String {
    let ev = &row.event;
    let mut out = String::new();
    push_prop(&mut out, "BEGIN", "VCALENDAR");
    push_prop(&mut out, "PRODID", "-//Comail//Comail Calendar//EN");
    push_prop(&mut out, "VERSION", "2.0");
    push_prop(&mut out, "BEGIN", "VEVENT");
    push_prop(&mut out, "UID", &row.ical_uid);
    push_prop(&mut out, "DTSTAMP", &fmt_utc(now_ms()));
    push_prop(&mut out, "SEQUENCE", &row.sequence.to_string());
    if ev.all_day {
        fold(
            &format!("DTSTART;VALUE=DATE:{}", fmt_local_date(ev.starts_at)),
            &mut out,
        );
        fold(
            &format!(
                "DTEND;VALUE=DATE:{}",
                fmt_local_date(ev.ends_at.unwrap_or(ev.starts_at + 86_400_000))
            ),
            &mut out,
        );
    } else {
        push_prop(&mut out, "DTSTART", &fmt_utc(ev.starts_at));
        push_prop(
            &mut out,
            "DTEND",
            &fmt_utc(ev.ends_at.unwrap_or(ev.starts_at + 1_800_000)),
        );
    }
    if let Some(s) = &ev.summary {
        push_prop(&mut out, "SUMMARY", &escape(s));
    }
    if let Some(l) = &ev.location {
        push_prop(&mut out, "LOCATION", &escape(l));
    }
    if let Some(d) = &ev.description {
        push_prop(&mut out, "DESCRIPTION", &escape(d));
    }
    if let Some(u) = &ev.join_url {
        push_prop(&mut out, "URL", u);
    }
    if let Some(st) = &ev.status {
        push_prop(&mut out, "STATUS", st);
    }
    if let Some(r) = &ev.rrule {
        push_prop(&mut out, "RRULE", r);
    }
    if let Some(o) = &ev.organizer {
        if !o.is_empty() {
            fold(&format!("ORGANIZER:mailto:{o}"), &mut out);
        }
    }
    for a in &ev.attendees {
        // Our own PARTSTAT reflects the local RSVP.
        let partstat = if self_email.is_some_and(|me| me.eq_ignore_ascii_case(&a.email)) {
            ev.rsvp_status.clone().or_else(|| a.partstat.clone())
        } else {
            a.partstat.clone()
        };
        let ps = partstat.unwrap_or_else(|| "NEEDS-ACTION".into());
        fold(
            &format!("ATTENDEE;PARTSTAT={ps}:mailto:{}", a.email),
            &mut out,
        );
    }
    // Carry-overs from the raw server copy.
    if let Some(raw) = &row.ical_raw {
        for chunk in preserved_chunks(raw) {
            out.push_str(&chunk);
        }
    }
    push_prop(&mut out, "END", "VEVENT");
    // Override VEVENTs ride outside the master.
    if let Some(raw) = &row.ical_raw {
        for block in override_vevents(raw) {
            out.push_str(&block);
        }
    }
    push_prop(&mut out, "END", "VCALENDAR");
    out
}

fn fmt_local_date(ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(ms)
        .earliest()
        .map(|d| d.format("%Y%m%d").to_string())
        .unwrap_or_default()
}

/// EXDATE lines and VALARM blocks of the master VEVENT, re-emitted verbatim
/// (each returned chunk ends with CRLF).
fn preserved_chunks(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_master = false;
    let mut in_alarm = false;
    let mut alarm = String::new();
    let mut seen_recurrence_id = false;
    let mut master_lines: Vec<&str> = Vec::new();
    // Identify the master VEVENT (no RECURRENCE-ID) first.
    let mut depth_master_found = false;
    let mut current: Vec<&str> = Vec::new();
    for line in raw.lines() {
        let l = line.trim_end_matches('\r');
        if l.eq_ignore_ascii_case("BEGIN:VEVENT") {
            current = Vec::new();
            seen_recurrence_id = false;
            in_master = true;
            continue;
        }
        if l.eq_ignore_ascii_case("END:VEVENT") {
            if in_master && !seen_recurrence_id && !depth_master_found {
                master_lines = current.clone();
                depth_master_found = true;
            }
            in_master = false;
            continue;
        }
        if in_master {
            if l.to_ascii_uppercase().starts_with("RECURRENCE-ID") {
                seen_recurrence_id = true;
            }
            current.push(l);
        }
    }
    for l in master_lines {
        let upper = l.to_ascii_uppercase();
        if in_alarm {
            alarm.push_str(l);
            alarm.push_str("\r\n");
            if upper == "END:VALARM" {
                out.push(std::mem::take(&mut alarm));
                in_alarm = false;
            }
            continue;
        }
        if upper == "BEGIN:VALARM" {
            in_alarm = true;
            alarm.push_str(l);
            alarm.push_str("\r\n");
        } else if upper.starts_with("EXDATE") {
            out.push(format!("{l}\r\n"));
        }
    }
    out
}

/// Override VEVENT blocks (with RECURRENCE-ID), verbatim.
fn override_vevents(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut in_event = false;
    let mut has_rid = false;
    for line in raw.lines() {
        let l = line.trim_end_matches('\r');
        if l.eq_ignore_ascii_case("BEGIN:VEVENT") {
            in_event = true;
            has_rid = false;
            current = vec![l.to_string()];
            continue;
        }
        if l.eq_ignore_ascii_case("END:VEVENT") {
            current.push(l.to_string());
            if in_event && has_rid {
                out.push(format!("{}\r\n", current.join("\r\n")));
            }
            in_event = false;
            continue;
        }
        if in_event {
            if l.to_ascii_uppercase().starts_with("RECURRENCE-ID") {
                has_rid = true;
            }
            current.push(l.to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caldav::http::{DavResponse, MockTransport};
    use crate::caldav::sync::tests::{ms207, seed_db};
    use crate::models::UpdateEventArgs;

    async fn seed_synced_event(db: &Db) -> i64 {
        db.write(|c| {
            let ev = crate::calendar::IcsEvent {
                uid: "p1@server".into(),
                summary: Some("Server".into()),
                starts_at_ms: 1_000,
                ends_at_ms: Some(2_000),
                ..Default::default()
            };
            repo::calendar::upsert_remote(
                c,
                1,
                10,
                "/cal/me/work/p1.ics",
                "\"e0\"",
                "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:p1@server\r\nDTSTART:19700101T000001Z\r\nBEGIN:VALARM\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR",
                &ev,
            )?;
            Ok(())
        })
        .await
        .unwrap();
        db.read(|c| {
            Ok(c.query_row(
                "SELECT id FROM calendar_events WHERE ical_uid = 'p1@server'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap()
    }

    fn edit(db_id: i64) -> UpdateEventArgs {
        UpdateEventArgs {
            event_id: db_id,
            summary: "Edited".into(),
            description: None,
            location: None,
            join_url: None,
            starts_at: 5_000,
            ends_at: 6_000,
            all_day: false,
            attendees: vec![],
            notify: false,
        }
    }

    #[tokio::test]
    async fn put_update_sends_if_match_and_clears_dirty() {
        let (db, _dir) = seed_db().await;
        let bus = EventBus::new();
        let id = seed_synced_event(&db).await;
        db.write(move |c| repo::calendar::update_local_fields(c, &edit(id), &[]))
            .await
            .unwrap();

        let ok = DavResponse {
            status: 204,
            etag: Some("\"e1\"".into()),
            body: String::new(),
        };
        let t = MockTransport::new(vec![ok]);
        assert!(push_dirty(&db, &bus, &t, 1).await.unwrap());

        let seen = t.seen.lock().unwrap();
        assert_eq!(seen[0].0, "PUT");
        assert!(seen[0].1.ends_with("/cal/me/work/p1.ics"));
        let body = seen[0].2.as_ref().unwrap();
        assert!(body.contains("SUMMARY:Edited"));
        assert!(body.contains("SEQUENCE:1"));
        assert!(!body.contains("METHOD"));
        assert!(body.contains("BEGIN:VALARM"), "alarm carried over");
        let headers = t.headers_seen.lock().unwrap();
        assert_eq!(
            headers[0].get("If-Match").map(String::as_str),
            Some("\"e0\"")
        );
        drop(seen);
        drop(headers);

        let row = db
            .read(move |c| repo::calendar::sync_row_for(c, id))
            .await
            .unwrap()
            .unwrap();
        assert!(!row.event.summary.is_none());
        assert_eq!(row.etag.as_deref(), Some("\"e1\""));
        assert!(db
            .read(|c| repo::calendar::dirty_rows(c, 1))
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn create_uses_if_none_match_on_default_calendar() {
        let (db, _dir) = seed_db().await;
        let bus = EventBus::new();
        let id = db
            .write(|c| {
                repo::calendar::insert_local(
                    c,
                    1,
                    "new-1@comail",
                    "Fresh",
                    None,
                    None,
                    None,
                    "me@test.dev",
                    &[],
                    1_000,
                    2_000,
                    false,
                )
            })
            .await
            .unwrap();
        db.write(move |c| repo::calendar::mark_dirty(c, id))
            .await
            .unwrap();

        let ok = DavResponse {
            status: 201,
            etag: Some("\"n1\"".into()),
            body: String::new(),
        };
        let t = MockTransport::new(vec![ok]);
        assert!(push_dirty(&db, &bus, &t, 1).await.unwrap());
        let headers = t.headers_seen.lock().unwrap();
        assert_eq!(
            headers[0].get("If-None-Match").map(String::as_str),
            Some("*")
        );
        drop(headers);
        let row = db
            .read(move |c| repo::calendar::sync_row_for(c, id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.event.calendar_id, Some(10));
        assert!(row
            .caldav_href
            .as_deref()
            .unwrap()
            .ends_with("new-1@comail.ics"));
    }

    #[tokio::test]
    async fn conflict_412_keeps_both_versions() {
        let (db, _dir) = seed_db().await;
        let bus = EventBus::new();
        let id = seed_synced_event(&db).await;
        db.write(move |c| repo::calendar::update_local_fields(c, &edit(id), &[]))
            .await
            .unwrap();

        let precondition = DavResponse {
            status: 412,
            etag: None,
            body: String::new(),
        };
        let server_copy = DavResponse {
            status: 200,
            etag: Some("\"srv\"".into()),
            body: "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:p1@server\r\nSUMMARY:Server truth\r\nDTSTART:20260801T090000Z\r\nDTEND:20260801T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR".into(),
        };
        let t = MockTransport::new(vec![precondition, server_copy]);
        push_dirty(&db, &bus, &t, 1).await.unwrap();

        let events = db
            .read(|c| repo::calendar::list_range(c, 0, i64::MAX / 2))
            .await
            .unwrap();
        assert_eq!(events.len(), 2, "server row + conflict copy");
        let summaries: Vec<_> = events.iter().filter_map(|e| e.summary.clone()).collect();
        assert!(summaries.iter().any(|s| s == "Server truth"));
        assert!(summaries.iter().any(|s| s.contains("(conflict copy)")));
        assert!(db
            .read(|c| repo::calendar::dirty_rows(c, 1))
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn tombstone_delete_sends_if_match() {
        let (db, _dir) = seed_db().await;
        let bus = EventBus::new();
        let id = seed_synced_event(&db).await;
        db.write(move |c| repo::calendar::mark_deleted(c, id))
            .await
            .unwrap();

        let ok = DavResponse {
            status: 204,
            etag: None,
            body: String::new(),
        };
        let t = MockTransport::new(vec![ok]);
        push_dirty(&db, &bus, &t, 1).await.unwrap();
        let seen = t.seen.lock().unwrap();
        assert_eq!(seen[0].0, "DELETE");
        drop(seen);
        assert!(db
            .read(move |c| repo::calendar::sync_row_for(c, id))
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn rsvp_partstat_lands_in_put_body() {
        let (db, _dir) = seed_db().await;
        let bus = EventBus::new();
        let id = db
            .write(|c| {
                let ev = crate::calendar::IcsEvent {
                    uid: "inv-1@remote".into(),
                    summary: Some("Invite".into()),
                    organizer: Some("alice@x".into()),
                    attendees: vec![crate::calendar::IcsAttendee {
                        email: "me@test.dev".into(),
                        name: None,
                        partstat: Some("NEEDS-ACTION".into()),
                    }],
                    starts_at_ms: 1_000,
                    ends_at_ms: Some(2_000),
                    ..Default::default()
                };
                repo::calendar::upsert_remote(
                    c,
                    1,
                    10,
                    "/cal/me/work/inv1.ics",
                    "\"i0\"",
                    "RAW",
                    &ev,
                )?;
                let id: i64 = c.query_row(
                    "SELECT id FROM calendar_events WHERE ical_uid = 'inv-1@remote'",
                    [],
                    |r| r.get(0),
                )?;
                repo::calendar::set_rsvp(c, id, "ACCEPTED")?;
                repo::calendar::mark_dirty(c, id)?;
                Ok(id)
            })
            .await
            .unwrap();
        let _ = id;

        let ok = DavResponse {
            status: 204,
            etag: Some("\"i1\"".into()),
            body: String::new(),
        };
        let t = MockTransport::new(vec![ok]);
        push_dirty(&db, &bus, &t, 1).await.unwrap();
        let seen = t.seen.lock().unwrap();
        let body = seen[0].2.as_ref().unwrap();
        assert!(
            body.contains("ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@test.dev"),
            "{body}"
        );
    }
}
