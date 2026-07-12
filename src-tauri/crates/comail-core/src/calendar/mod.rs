//! Minimal iCalendar (RFC 5545) parsing - just enough for meeting invites
//! carried in text/calendar MIME parts: VEVENT with UID/SUMMARY/DTSTART/
//! DTEND/LOCATION/ORGANIZER/STATUS plus the calendar-level METHOD.

use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};

#[derive(Debug, Clone, Default)]
pub struct IcsEvent {
    pub uid: String,
    pub method: Option<String>,
    pub summary: Option<String>,
    pub location: Option<String>,
    pub organizer: Option<String>,
    pub starts_at_ms: i64,
    pub ends_at_ms: Option<i64>,
    pub all_day: bool,
    pub status: Option<String>,
}

/// Unfold RFC 5545 folded lines (continuations start with space or tab).
fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.lines() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if (line.starts_with(' ') || line.starts_with('\t')) && !out.is_empty() {
            let cont = &line[1..];
            out.last_mut().unwrap().push_str(cont);
        } else {
            out.push(line.to_string());
        }
    }
    out
}

/// "KEY;PARAM=X;PARAM=Y:VALUE" -> (KEY, VALUE). Params are ignored except
/// that their presence doesn't confuse the split (':' inside params is rare
/// and unsupported).
fn split_prop(line: &str) -> Option<(String, String)> {
    let (lhs, value) = line.split_once(':')?;
    let key = lhs.split(';').next()?.to_ascii_uppercase();
    Some((key, value.to_string()))
}

/// Parse "20260711", "20260711T130000", "20260711T130000Z" to (ms, all_day).
/// Naive datetimes (with or without TZID) are treated as local time.
fn parse_dt(value: &str) -> Option<(i64, bool)> {
    let v = value.trim();
    if let Ok(d) = NaiveDate::parse_from_str(v, "%Y%m%d") {
        let dt = d.and_hms_opt(0, 0, 0)?;
        let ms = chrono::Local
            .from_local_datetime(&dt)
            .earliest()?
            .timestamp_millis();
        return Some((ms, true));
    }
    if let Some(stripped) = v.strip_suffix('Z') {
        let dt = NaiveDateTime::parse_from_str(stripped, "%Y%m%dT%H%M%S").ok()?;
        return Some((Utc.from_utc_datetime(&dt).timestamp_millis(), false));
    }
    let dt = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()?;
    Some((
        chrono::Local
            .from_local_datetime(&dt)
            .earliest()?
            .timestamp_millis(),
        false,
    ))
}

fn unescape(v: &str) -> String {
    v.replace("\\n", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
}

pub fn parse_ics(text: &str) -> Vec<IcsEvent> {
    let lines = unfold(text);
    let mut method: Option<String> = None;
    let mut events = Vec::new();
    let mut current: Option<IcsEvent> = None;

    for line in &lines {
        let Some((key, value)) = split_prop(line) else {
            continue;
        };
        match key.as_str() {
            "BEGIN" if value.eq_ignore_ascii_case("VEVENT") => {
                current = Some(IcsEvent::default());
            }
            "END" if value.eq_ignore_ascii_case("VEVENT") => {
                if let Some(mut ev) = current.take() {
                    ev.method = method.clone();
                    if !ev.uid.is_empty() && ev.starts_at_ms != 0 {
                        events.push(ev);
                    }
                }
            }
            "METHOD" if current.is_none() => method = Some(value.to_ascii_uppercase()),
            _ => {
                let Some(ev) = current.as_mut() else { continue };
                match key.as_str() {
                    "UID" => ev.uid = value.trim().to_string(),
                    "SUMMARY" => ev.summary = Some(unescape(value.trim())),
                    "LOCATION" => ev.location = Some(unescape(value.trim())),
                    "STATUS" => ev.status = Some(value.trim().to_ascii_uppercase()),
                    "ORGANIZER" => {
                        // "mailto:alice@x.com" or "CN=Alice:mailto:…" (params
                        // were stripped); keep the address.
                        ev.organizer = Some(value.trim().trim_start_matches("mailto:").to_string());
                    }
                    "DTSTART" => {
                        if let Some((ms, all_day)) = parse_dt(&value) {
                            ev.starts_at_ms = ms;
                            ev.all_day = all_day;
                        }
                    }
                    "DTEND" => {
                        if let Some((ms, _)) = parse_dt(&value) {
                            ev.ends_at_ms = Some(ms);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:evt-1@cal.example.com\r\nSUMMARY:Design review\\, part 2\r\nLOCATION:Room 4\r\nORGANIZER;CN=Alice:mailto:alice@example.com\r\nDTSTART:20260715T140000Z\r\nDTEND:20260715T150000Z\r\nSTATUS:CONFIRMED\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn parses_invite() {
        let events = parse_ics(SAMPLE);
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert_eq!(ev.uid, "evt-1@cal.example.com");
        assert_eq!(ev.summary.as_deref(), Some("Design review, part 2"));
        assert_eq!(ev.method.as_deref(), Some("REQUEST"));
        assert_eq!(ev.organizer.as_deref(), Some("alice@example.com"));
        assert!(!ev.all_day);
        assert_eq!(ev.ends_at_ms.unwrap() - ev.starts_at_ms, 3_600_000);
    }

    #[test]
    fn parses_all_day_and_folding() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:evt-2\r\nSUMMARY:Offsite\r\n day one\r\nDTSTART:20260801\r\nEND:VEVENT\r\nEND:VCALENDAR";
        let events = parse_ics(ics);
        assert_eq!(events.len(), 1);
        assert!(events[0].all_day);
        assert_eq!(events[0].summary.as_deref(), Some("Offsiteday one"));
    }
}
