use crate::calendar::IcsEvent;
use crate::error::Result;
use crate::models::{CalendarEvent, EventAttendee, UpdateEventArgs};
use rusqlite::{params, Connection, OptionalExtension, Row};

fn from_row(row: &Row) -> rusqlite::Result<CalendarEvent> {
    let attendees_json: Option<String> = row.get("attendees_json")?;
    let attendees = attendees_json
        .as_deref()
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default();
    Ok(CalendarEvent {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        message_id: row.get("message_id")?,
        summary: row.get("summary")?,
        location: row.get("location")?,
        organizer: row.get("organizer")?,
        description: row.get("description")?,
        attendees,
        join_url: row.get("join_url")?,
        rsvp_status: row.get("rsvp_status")?,
        is_local: row.get::<_, i64>("is_local")? != 0,
        calendar_id: row.get("calendar_id")?,
        rrule: row.get("rrule")?,
        starts_at: row.get("starts_at")?,
        ends_at: row.get("ends_at")?,
        all_day: row.get::<_, i64>("all_day")? != 0,
        status: row.get("status")?,
        method: row.get("method")?,
    })
}

/// Everything the CalDAV push path needs about one dirty/tombstoned row.
#[derive(Debug, Clone)]
pub struct SyncRow {
    pub event: CalendarEvent,
    pub ical_uid: String,
    pub sequence: i64,
    pub caldav_href: Option<String>,
    pub etag: Option<String>,
    pub ical_raw: Option<String>,
    pub deleted: bool,
}

fn sync_row(row: &Row) -> rusqlite::Result<SyncRow> {
    Ok(SyncRow {
        event: from_row(row)?,
        ical_uid: row.get("ical_uid")?,
        sequence: row.get("sequence")?,
        caldav_href: row.get("caldav_href")?,
        etag: row.get("etag")?,
        ical_raw: row.get("ical_raw")?,
        deleted: row.get::<_, i64>("deleted")? != 0,
    })
}

fn attendees_json(ev: &IcsEvent) -> Result<Option<String>> {
    if ev.attendees.is_empty() {
        return Ok(None);
    }
    let list: Vec<EventAttendee> = ev
        .attendees
        .iter()
        .map(|a| EventAttendee {
            email: a.email.clone(),
            name: a.name.clone(),
            partstat: a.partstat.clone(),
        })
        .collect();
    Ok(Some(serde_json::to_string(&list)?))
}

fn attendees_to_json(list: &[EventAttendee]) -> Result<Option<String>> {
    if list.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string(list)?))
}

/// Upsert by iCal UID (mail-invite path). CANCEL marks the stored event
/// cancelled; REQUEST (or anything else) replaces the details - later invite
/// updates win. Our own RSVP state, the is_local flag, and CalDAV sync
/// bookkeeping survive updates.
pub fn upsert(conn: &Connection, account_id: i64, message_id: i64, ev: &IcsEvent) -> Result<()> {
    if ev.method.as_deref() == Some("CANCEL") {
        conn.execute(
            "UPDATE calendar_events SET status = 'CANCELLED', method = 'CANCEL'
             WHERE account_id = ?1 AND ical_uid = ?2",
            params![account_id, ev.uid],
        )?;
        return Ok(());
    }
    conn.execute(
        "INSERT INTO calendar_events
            (account_id, message_id, ical_uid, method, summary, location, organizer,
             description, attendees_json, join_url, sequence, rrule, tzid,
             starts_at, ends_at, all_day, status)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
         ON CONFLICT(account_id, ical_uid) DO UPDATE SET
            message_id = excluded.message_id,
            method = excluded.method,
            summary = excluded.summary,
            location = excluded.location,
            organizer = excluded.organizer,
            description = excluded.description,
            attendees_json = excluded.attendees_json,
            join_url = excluded.join_url,
            sequence = excluded.sequence,
            rrule = excluded.rrule,
            tzid = excluded.tzid,
            starts_at = excluded.starts_at,
            ends_at = excluded.ends_at,
            all_day = excluded.all_day,
            status = excluded.status
         WHERE calendar_events.dirty = 0",
        params![
            account_id,
            message_id,
            ev.uid,
            ev.method,
            ev.summary,
            ev.location,
            ev.organizer,
            ev.description,
            attendees_json(ev)?,
            ev.join_url,
            ev.sequence,
            ev.rrule,
            ev.tzid,
            ev.starts_at_ms,
            ev.ends_at_ms,
            ev.all_day as i64,
            ev.status,
        ],
    )?;
    Ok(())
}

/// Upsert an event pulled from a CalDAV collection, keyed by (calendar_id,
/// href) with a UID fallback (adopts rows that arrived first as mail
/// invites). Rows with local unsynced edits (dirty/deleted) are never
/// clobbered - the push path resolves them via If-Match.
#[allow(clippy::too_many_arguments)]
pub fn upsert_remote(
    conn: &Connection,
    account_id: i64,
    calendar_id: i64,
    href: &str,
    etag: &str,
    ical_raw: &str,
    ev: &IcsEvent,
) -> Result<()> {
    let existing: Option<(i64, i64, i64)> = conn
        .query_row(
            "SELECT id, dirty, deleted FROM calendar_events
             WHERE (calendar_id = ?1 AND caldav_href = ?2)
                OR (account_id = ?3 AND ical_uid = ?4)
             LIMIT 1",
            params![calendar_id, href, account_id, ev.uid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;

    match existing {
        Some((_, dirty, deleted)) if dirty != 0 || deleted != 0 => Ok(()),
        Some((id, _, _)) => {
            conn.execute(
                "UPDATE calendar_events SET
                    calendar_id = ?2, caldav_href = ?3, etag = ?4, ical_raw = ?5,
                    summary = ?6, location = ?7, organizer = ?8, description = ?9,
                    attendees_json = ?10, join_url = ?11, sequence = ?12,
                    rrule = ?13, tzid = ?14, starts_at = ?15, ends_at = ?16,
                    all_day = ?17, status = ?18
                 WHERE id = ?1",
                params![
                    id,
                    calendar_id,
                    href,
                    etag,
                    ical_raw,
                    ev.summary,
                    ev.location,
                    ev.organizer,
                    ev.description,
                    attendees_json(ev)?,
                    ev.join_url,
                    ev.sequence,
                    ev.rrule,
                    ev.tzid,
                    ev.starts_at_ms,
                    ev.ends_at_ms,
                    ev.all_day as i64,
                    ev.status,
                ],
            )?;
            Ok(())
        }
        None => {
            conn.execute(
                "INSERT INTO calendar_events
                    (account_id, calendar_id, caldav_href, etag, ical_raw, ical_uid,
                     summary, location, organizer, description, attendees_json,
                     join_url, sequence, rrule, tzid, starts_at, ends_at, all_day, status)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
                params![
                    account_id,
                    calendar_id,
                    href,
                    etag,
                    ical_raw,
                    ev.uid,
                    ev.summary,
                    ev.location,
                    ev.organizer,
                    ev.description,
                    attendees_json(ev)?,
                    ev.join_url,
                    ev.sequence,
                    ev.rrule,
                    ev.tzid,
                    ev.starts_at_ms,
                    ev.ends_at_ms,
                    ev.all_day as i64,
                    ev.status,
                ],
            )?;
            Ok(())
        }
    }
}

/// Insert an event created in Comail (we are the organizer).
#[allow(clippy::too_many_arguments)]
pub fn insert_local(
    conn: &Connection,
    account_id: i64,
    uid: &str,
    summary: &str,
    location: Option<&str>,
    description: Option<&str>,
    join_url: Option<&str>,
    organizer: &str,
    attendees: &[EventAttendee],
    starts_at: i64,
    ends_at: i64,
    all_day: bool,
) -> Result<i64> {
    let attendees_json = attendees_to_json(attendees)?;
    conn.execute(
        "INSERT INTO calendar_events
            (account_id, ical_uid, method, summary, location, organizer,
             description, attendees_json, join_url, is_local,
             starts_at, ends_at, all_day, status)
         VALUES (?1,?2,'REQUEST',?3,?4,?5,?6,?7,?8,1,?9,?10,?11,'CONFIRMED')",
        params![
            account_id,
            uid,
            summary,
            location,
            organizer,
            description,
            attendees_json,
            join_url,
            starts_at,
            ends_at,
            all_day as i64,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Apply a local edit: replace the user-editable fields, bump SEQUENCE, and
/// flag the row dirty so the CalDAV push picks it up.
pub fn update_local_fields(
    conn: &Connection,
    args: &UpdateEventArgs,
    attendees: &[EventAttendee],
) -> Result<()> {
    conn.execute(
        "UPDATE calendar_events SET
            summary = ?2, description = ?3, location = ?4, join_url = ?5,
            starts_at = ?6, ends_at = ?7, all_day = ?8, attendees_json = ?9,
            sequence = sequence + 1, dirty = 1
         WHERE id = ?1",
        params![
            args.event_id,
            args.summary,
            args.description,
            args.location,
            args.join_url,
            args.starts_at,
            args.ends_at,
            args.all_day as i64,
            attendees_to_json(attendees)?,
        ],
    )?;
    Ok(())
}

/// Flag our own RSVP change for the CalDAV push (PARTSTAT PUT).
pub fn mark_dirty(conn: &Connection, event_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE calendar_events SET dirty = 1 WHERE id = ?1",
        params![event_id],
    )?;
    Ok(())
}

/// Tombstone: hidden from every listing, deleted on the server at next push.
pub fn mark_deleted(conn: &Connection, event_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE calendar_events SET deleted = 1, status = 'CANCELLED' WHERE id = ?1",
        params![event_id],
    )?;
    Ok(())
}

pub fn hard_delete(conn: &Connection, event_id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM calendar_events WHERE id = ?1",
        params![event_id],
    )?;
    Ok(())
}

/// After a successful PUT: record the server's identity for the row.
pub fn clear_dirty_set_etag(
    conn: &Connection,
    event_id: i64,
    calendar_id: i64,
    href: &str,
    etag: Option<&str>,
    ical_raw: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE calendar_events SET dirty = 0, calendar_id = ?2, caldav_href = ?3,
                etag = COALESCE(?4, etag), ical_raw = ?5
         WHERE id = ?1",
        params![event_id, calendar_id, href, etag, ical_raw],
    )?;
    Ok(())
}

/// Rows with unsynced local changes (edits and tombstones) for one account.
pub fn dirty_rows(conn: &Connection, account_id: i64) -> Result<Vec<SyncRow>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM calendar_events
         WHERE account_id = ?1 AND (dirty = 1 OR deleted = 1)",
    )?;
    let rows = stmt
        .query_map(params![account_id], sync_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn sync_row_for(conn: &Connection, event_id: i64) -> Result<Option<SyncRow>> {
    let mut stmt = conn.prepare("SELECT * FROM calendar_events WHERE id = ?1")?;
    let mut rows = stmt.query_map(params![event_id], sync_row)?;
    Ok(rows.next().transpose()?)
}

/// (id, href, etag) for every synced event of one collection - the pull pass
/// diffs this against the server listing to find remote deletions/changes.
pub fn hrefs_for_calendar(
    conn: &Connection,
    calendar_id: i64,
) -> Result<Vec<(i64, String, Option<String>)>> {
    let mut stmt = conn.prepare(
        "SELECT id, caldav_href, etag FROM calendar_events
         WHERE calendar_id = ?1 AND caldav_href IS NOT NULL",
    )?;
    let rows = stmt
        .query_map(params![calendar_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Remove an event the server no longer has (unless locally dirty).
pub fn delete_by_href(conn: &Connection, calendar_id: i64, href: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM calendar_events
         WHERE calendar_id = ?1 AND caldav_href = ?2 AND dirty = 0 AND deleted = 0",
        params![calendar_id, href],
    )?;
    Ok(())
}

/// Record our RSVP (ACCEPTED | TENTATIVE | DECLINED).
pub fn set_rsvp(conn: &Connection, event_id: i64, status: &str) -> Result<()> {
    conn.execute(
        "UPDATE calendar_events SET rsvp_status = ?2 WHERE id = ?1",
        params![event_id, status],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, event_id: i64) -> Result<Option<CalendarEvent>> {
    let mut stmt = conn.prepare("SELECT * FROM calendar_events WHERE id = ?1")?;
    let mut rows = stmt.query_map(params![event_id], from_row)?;
    Ok(rows.next().transpose()?)
}

/// The stored iCal UID + sequence (needed to build an RSVP reply).
pub fn uid_and_sequence(conn: &Connection, event_id: i64) -> Result<Option<(String, i64)>> {
    let mut stmt = conn.prepare("SELECT ical_uid, sequence FROM calendar_events WHERE id = ?1")?;
    let mut rows = stmt.query_map(params![event_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.next().transpose()?)
}

pub fn list_range(conn: &Connection, start_ms: i64, end_ms: i64) -> Result<Vec<CalendarEvent>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM calendar_events
         WHERE deleted = 0 AND starts_at < ?2 AND COALESCE(ends_at, starts_at) >= ?1
         ORDER BY starts_at ASC LIMIT 500",
    )?;
    let rows = stmt
        .query_map(params![start_ms, end_ms], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Recurring masters that could produce occurrences in [start, end): started
/// before the window ends and still repeat (the expander applies UNTIL/COUNT).
pub fn recurring_masters(conn: &Connection, end_ms: i64) -> Result<Vec<SyncRow>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM calendar_events
         WHERE deleted = 0 AND rrule IS NOT NULL AND starts_at < ?1
         LIMIT 500",
    )?;
    let rows = stmt
        .query_map(params![end_ms], sync_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Events attached to one message (for the invite card in the thread view).
pub fn for_message(conn: &Connection, message_id: i64) -> Result<Vec<CalendarEvent>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM calendar_events WHERE message_id = ?1 AND deleted = 0 ORDER BY starts_at",
    )?;
    let rows = stmt
        .query_map(params![message_id], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Non-recurring events starting within the reminder window that have not
/// been notified for this start time yet. (Recurring occurrences are handled
/// by the caller via the expander; the notified_at gate is per-occurrence.)
pub fn upcoming_for_notify(
    conn: &Connection,
    now: i64,
    lead_ms: i64,
) -> Result<Vec<CalendarEvent>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM calendar_events
         WHERE deleted = 0 AND all_day = 0
           AND COALESCE(status,'') != 'CANCELLED'
           AND COALESCE(rsvp_status,'') != 'DECLINED'
           AND starts_at > ?1 AND starts_at <= ?1 + ?2
           AND (notified_at IS NULL OR notified_at < starts_at)
         ORDER BY starts_at LIMIT 20",
    )?;
    let rows = stmt
        .query_map(params![now, lead_ms], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn set_notified(conn: &Connection, event_id: i64, occurrence_start: i64) -> Result<()> {
    conn.execute(
        "UPDATE calendar_events SET notified_at = ?2 WHERE id = ?1",
        params![event_id, occurrence_start],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::IcsAttendee;
    use crate::db::testutil;
    use crate::models::Address;

    fn sample_ics_event() -> IcsEvent {
        IcsEvent {
            uid: "evt-1@test".into(),
            method: Some("REQUEST".into()),
            summary: Some("Sync".into()),
            organizer: Some("alice@test.dev".into()),
            description: Some("agenda".into()),
            attendees: vec![IcsAttendee {
                email: "me@test.dev".into(),
                name: Some("Me".into()),
                partstat: Some("NEEDS-ACTION".into()),
            }],
            join_url: Some("https://meet.google.com/x".into()),
            sequence: 1,
            starts_at_ms: 1_000_000,
            ends_at_ms: Some(2_000_000),
            ..Default::default()
        }
    }

    fn seed_calendar(c: &Connection) -> i64 {
        c.execute(
            "INSERT INTO calendars (account_id, url, display_name) VALUES (1, 'https://cal/x/', 'Main')",
            [],
        )
        .unwrap();
        c.last_insert_rowid()
    }

    #[test]
    fn upsert_roundtrips_details_and_preserves_rsvp() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (_t, msg) = testutil::seed_message(&c, "alice@test.dev", "Sync", false);

        upsert(&c, 1, msg, &sample_ics_event()).unwrap();
        let ev = &for_message(&c, msg).unwrap()[0];
        assert_eq!(ev.description.as_deref(), Some("agenda"));
        assert_eq!(ev.join_url.as_deref(), Some("https://meet.google.com/x"));
        assert_eq!(ev.attendees.len(), 1);
        assert_eq!(ev.attendees[0].email, "me@test.dev");
        assert!(!ev.is_local);

        // RSVP survives a later invite update.
        set_rsvp(&c, ev.id, "ACCEPTED").unwrap();
        let mut updated = sample_ics_event();
        updated.summary = Some("Sync v2".into());
        upsert(&c, 1, msg, &updated).unwrap();
        let ev2 = get(&c, ev.id).unwrap().unwrap();
        assert_eq!(ev2.summary.as_deref(), Some("Sync v2"));
        assert_eq!(ev2.rsvp_status.as_deref(), Some("ACCEPTED"));
        assert_eq!(uid_and_sequence(&c, ev.id).unwrap().unwrap().1, 1);
    }

    #[test]
    fn insert_local_lists_in_range() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let id = insert_local(
            &c,
            1,
            "local-1@comail",
            "Planning",
            Some("Room 9"),
            None,
            None,
            "me@test.dev",
            &[],
            5_000,
            6_000,
            false,
        )
        .unwrap();
        let ev = get(&c, id).unwrap().unwrap();
        assert!(ev.is_local);
        assert_eq!(ev.organizer.as_deref(), Some("me@test.dev"));
        assert_eq!(list_range(&c, 0, 10_000).unwrap().len(), 1);
        assert_eq!(list_range(&c, 7_000, 10_000).unwrap().len(), 0);
    }

    #[test]
    fn dirty_and_tombstone_lifecycle() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let cal = seed_calendar(&c);
        let id = insert_local(
            &c,
            1,
            "u1@comail",
            "Edit me",
            None,
            None,
            None,
            "me@test.dev",
            &[],
            5_000,
            6_000,
            false,
        )
        .unwrap();

        // Local edit bumps sequence and flags dirty.
        let args = UpdateEventArgs {
            event_id: id,
            summary: "Edited".into(),
            description: None,
            location: Some("Room 1".into()),
            join_url: None,
            starts_at: 7_000,
            ends_at: 8_000,
            all_day: false,
            attendees: vec![Address {
                name: None,
                email: "bob@test.dev".into(),
            }],
            notify: true,
        };
        let atts = vec![EventAttendee {
            email: "bob@test.dev".into(),
            name: None,
            partstat: Some("NEEDS-ACTION".into()),
        }];
        update_local_fields(&c, &args, &atts).unwrap();
        let rows = dirty_rows(&c, 1).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sequence, 1);
        assert_eq!(rows[0].event.summary.as_deref(), Some("Edited"));

        // Remote pull must not clobber the dirty row.
        let mut remote = sample_ics_event();
        remote.uid = "u1@comail".into();
        remote.summary = Some("Server version".into());
        upsert_remote(
            &c,
            1,
            cal,
            "/cal/u1.ics",
            "\"e1\"",
            "BEGIN:VCALENDAR",
            &remote,
        )
        .unwrap();
        assert_eq!(
            get(&c, id).unwrap().unwrap().summary.as_deref(),
            Some("Edited")
        );

        // Successful push clears dirty and records server identity.
        clear_dirty_set_etag(&c, id, cal, "/cal/u1.ics", Some("\"e2\""), "ICSDATA").unwrap();
        assert!(dirty_rows(&c, 1).unwrap().is_empty());
        let row = sync_row_for(&c, id).unwrap().unwrap();
        assert_eq!(row.etag.as_deref(), Some("\"e2\""));
        assert_eq!(row.caldav_href.as_deref(), Some("/cal/u1.ics"));

        // Now the same remote upsert applies (row is clean).
        upsert_remote(&c, 1, cal, "/cal/u1.ics", "\"e3\"", "ICS2", &remote).unwrap();
        assert_eq!(
            get(&c, id).unwrap().unwrap().summary.as_deref(),
            Some("Server version")
        );

        // Tombstone hides from listings, shows in dirty_rows, hard delete ends it.
        mark_deleted(&c, id).unwrap();
        assert!(list_range(&c, 0, 100_000).unwrap().is_empty());
        assert_eq!(dirty_rows(&c, 1).unwrap().len(), 1);
        hard_delete(&c, id).unwrap();
        assert!(dirty_rows(&c, 1).unwrap().is_empty());
    }

    #[test]
    fn upsert_remote_adopts_mail_invite_row_by_uid() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (_t, msg) = testutil::seed_message(&c, "alice@test.dev", "Sync", false);
        upsert(&c, 1, msg, &sample_ics_event()).unwrap();
        let cal = seed_calendar(&c);

        upsert_remote(
            &c,
            1,
            cal,
            "/cal/evt-1.ics",
            "\"e1\"",
            "ICS",
            &sample_ics_event(),
        )
        .unwrap();
        // Still one row, now carrying CalDAV identity.
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM calendar_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        let ev = &for_message(&c, msg).unwrap()[0];
        assert_eq!(ev.calendar_id, Some(cal));
    }

    #[test]
    fn notify_window_and_gate() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let id = insert_local(
            &c,
            1,
            "n1@comail",
            "Standup",
            None,
            None,
            None,
            "me@test.dev",
            &[],
            100_000,
            101_000,
            false,
        )
        .unwrap();
        // Outside the window.
        assert!(upcoming_for_notify(&c, 0, 10_000).unwrap().is_empty());
        // Inside the window.
        assert_eq!(upcoming_for_notify(&c, 95_000, 10_000).unwrap().len(), 1);
        set_notified(&c, id, 100_000).unwrap();
        assert!(upcoming_for_notify(&c, 95_000, 10_000).unwrap().is_empty());
        // Declined events never notify.
        let id2 = insert_local(
            &c,
            1,
            "n2@comail",
            "Skip",
            None,
            None,
            None,
            "me@test.dev",
            &[],
            100_000,
            101_000,
            false,
        )
        .unwrap();
        set_rsvp(&c, id2, "DECLINED").unwrap();
        assert!(upcoming_for_notify(&c, 95_000, 10_000).unwrap().is_empty());
    }
}
