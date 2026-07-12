use crate::calendar::IcsEvent;
use crate::error::Result;
use crate::models::CalendarEvent;
use rusqlite::{params, Connection, Row};

fn from_row(row: &Row) -> rusqlite::Result<CalendarEvent> {
    Ok(CalendarEvent {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        message_id: row.get("message_id")?,
        summary: row.get("summary")?,
        location: row.get("location")?,
        organizer: row.get("organizer")?,
        starts_at: row.get("starts_at")?,
        ends_at: row.get("ends_at")?,
        all_day: row.get::<_, i64>("all_day")? != 0,
        status: row.get("status")?,
        method: row.get("method")?,
    })
}

/// Upsert by iCal UID. CANCEL marks the stored event cancelled; REQUEST (or
/// anything else) replaces the details - later invite updates win.
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
             starts_at, ends_at, all_day, status)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         ON CONFLICT(account_id, ical_uid) DO UPDATE SET
            message_id = excluded.message_id,
            method = excluded.method,
            summary = excluded.summary,
            location = excluded.location,
            organizer = excluded.organizer,
            starts_at = excluded.starts_at,
            ends_at = excluded.ends_at,
            all_day = excluded.all_day,
            status = excluded.status",
        params![
            account_id,
            message_id,
            ev.uid,
            ev.method,
            ev.summary,
            ev.location,
            ev.organizer,
            ev.starts_at_ms,
            ev.ends_at_ms,
            ev.all_day as i64,
            ev.status,
        ],
    )?;
    Ok(())
}

pub fn list_range(conn: &Connection, start_ms: i64, end_ms: i64) -> Result<Vec<CalendarEvent>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM calendar_events
         WHERE starts_at < ?2 AND COALESCE(ends_at, starts_at) >= ?1
         ORDER BY starts_at ASC LIMIT 500",
    )?;
    let rows = stmt
        .query_map(params![start_ms, end_ms], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Events attached to one message (for the invite card in the thread view).
pub fn for_message(conn: &Connection, message_id: i64) -> Result<Vec<CalendarEvent>> {
    let mut stmt =
        conn.prepare("SELECT * FROM calendar_events WHERE message_id = ?1 ORDER BY starts_at")?;
    let rows = stmt
        .query_map(params![message_id], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
