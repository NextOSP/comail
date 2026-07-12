//! Minimal iCalendar (RFC 5545) parsing and generation - enough for meeting
//! invites carried in text/calendar MIME parts: VEVENT with UID/SUMMARY/
//! DTSTART/DTEND/LOCATION/ORGANIZER/STATUS/DESCRIPTION/ATTENDEE plus the
//! calendar-level METHOD, and building REQUEST (new invite) / REPLY (RSVP)
//! calendars for outbound mail.

use crate::models::Address;
use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct IcsAttendee {
    pub email: String,
    pub name: Option<String>,
    /// NEEDS-ACTION | ACCEPTED | TENTATIVE | DECLINED
    pub partstat: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct IcsEvent {
    pub uid: String,
    pub method: Option<String>,
    pub summary: Option<String>,
    pub location: Option<String>,
    pub organizer: Option<String>,
    pub description: Option<String>,
    pub attendees: Vec<IcsAttendee>,
    /// Video-call link: explicit URL/X-GOOGLE-CONFERENCE property, or the
    /// first meeting-service URL found in location/description.
    pub join_url: Option<String>,
    pub sequence: i64,
    /// Raw RRULE value (e.g. "FREQ=WEEKLY;BYDAY=MO"); None = one-off event.
    pub rrule: Option<String>,
    /// TZID parameter of DTSTART, informational.
    pub tzid: Option<String>,
    /// For recurrence overrides: the original occurrence start this VEVENT
    /// replaces (RECURRENCE-ID).
    pub recurrence_id_ms: Option<i64>,
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

/// "KEY;PARAM=X;PARAM="Y":VALUE" -> (KEY, [(PARAM, X)…], VALUE). The name/
/// param section ends at the first ':' outside double quotes.
fn split_prop(line: &str) -> Option<(String, Vec<(String, String)>, String)> {
    let mut in_quotes = false;
    let mut colon = None;
    for (i, ch) in line.char_indices() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ':' if !in_quotes => {
                colon = Some(i);
                break;
            }
            _ => {}
        }
    }
    let colon = colon?;
    let (lhs, value) = (&line[..colon], &line[colon + 1..]);
    // Split the name/param section on ';' outside double quotes.
    let mut parts: Vec<String> = vec![String::new()];
    let mut quoted = false;
    for ch in lhs.chars() {
        match ch {
            '"' => quoted = !quoted,
            ';' if !quoted => parts.push(String::new()),
            _ => parts.last_mut().unwrap().push(ch),
        }
    }
    let mut parts = parts.into_iter();
    let key = parts.next()?.to_ascii_uppercase();
    let params = parts
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            Some((k.to_ascii_uppercase(), v.trim_matches('"').to_string()))
        })
        .collect();
    Some((key, params, value.to_string()))
}

fn param<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
    params
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

/// Parse "20260711", "20260711T130000", "20260711T130000Z" to (ms, all_day).
/// Naive datetimes (with or without TZID) are treated as local time.
pub(crate) fn parse_dt(value: &str) -> Option<(i64, bool)> {
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
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') | Some('N') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// Hosts whose URLs are treated as video-call join links.
const MEETING_HOSTS: &[&str] = &[
    "zoom.us",
    "meet.google.com",
    "teams.microsoft.com",
    "teams.live.com",
    "webex.com",
    "whereby.com",
    "meet.jit.si",
];

/// First meeting-service URL inside free text (location or description).
pub fn find_join_url(text: &str) -> Option<String> {
    for (idx, _) in text.match_indices("https://") {
        let rest = &text[idx..];
        let end = rest
            .find(|c: char| c.is_whitespace() || matches!(c, '>' | '"' | '\'' | ')' | ','))
            .unwrap_or(rest.len());
        let url = rest[..end].trim_end_matches(['.', ';']);
        if MEETING_HOSTS.iter().any(|h| {
            url.split('/')
                .nth(2)
                .is_some_and(|host| host == *h || host.ends_with(&format!(".{h}")))
        }) {
            return Some(url.to_string());
        }
    }
    None
}

pub fn parse_ics(text: &str) -> Vec<IcsEvent> {
    let lines = unfold(text);
    let mut method: Option<String> = None;
    let mut events = Vec::new();
    let mut current: Option<IcsEvent> = None;

    for line in &lines {
        let Some((key, params, value)) = split_prop(line) else {
            continue;
        };
        match key.as_str() {
            "BEGIN" if value.eq_ignore_ascii_case("VEVENT") => {
                current = Some(IcsEvent::default());
            }
            "END" if value.eq_ignore_ascii_case("VEVENT") => {
                if let Some(mut ev) = current.take() {
                    ev.method = method.clone();
                    if ev.join_url.is_none() {
                        ev.join_url = ev
                            .location
                            .as_deref()
                            .and_then(find_join_url)
                            .or_else(|| ev.description.as_deref().and_then(find_join_url));
                    }
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
                    "DESCRIPTION" => ev.description = Some(unescape(value.trim())),
                    "STATUS" => ev.status = Some(value.trim().to_ascii_uppercase()),
                    "SEQUENCE" => ev.sequence = value.trim().parse().unwrap_or(0),
                    "RRULE" => ev.rrule = Some(value.trim().to_string()),
                    "RECURRENCE-ID" => {
                        ev.recurrence_id_ms = parse_dt(&value).map(|(ms, _)| ms);
                    }
                    "EXDATE" => {
                        // Collected by the recurrence expander from the raw
                        // VCALENDAR; nothing to store on the master here.
                    }
                    "URL" | "X-GOOGLE-CONFERENCE" => {
                        if ev.join_url.is_none() {
                            let v = value.trim();
                            if v.starts_with("http") {
                                ev.join_url = Some(v.to_string());
                            }
                        }
                    }
                    "ORGANIZER" => {
                        ev.organizer =
                            Some(value.trim().trim_start_matches("mailto:").to_string());
                    }
                    "ATTENDEE" => {
                        let email = value.trim().trim_start_matches("mailto:").to_string();
                        if !email.is_empty() {
                            ev.attendees.push(IcsAttendee {
                                email,
                                name: param(&params, "CN").map(str::to_string),
                                partstat: param(&params, "PARTSTAT")
                                    .map(|s| s.to_ascii_uppercase()),
                            });
                        }
                    }
                    "DTSTART" => {
                        if let Some((ms, all_day)) = parse_dt(&value) {
                            ev.starts_at_ms = ms;
                            ev.all_day = all_day;
                        }
                        if let Some(tz) = param(&params, "TZID") {
                            ev.tzid = Some(tz.to_string());
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

// ---------- generation ----------

pub(crate) fn escape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for c in v.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ',' => out.push_str("\\,"),
            ';' => out.push_str("\\;"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            _ => out.push(c),
        }
    }
    out
}

pub(crate) fn fmt_utc(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .earliest()
        .unwrap_or_else(Utc::now)
        .format("%Y%m%dT%H%M%SZ")
        .to_string()
}

/// Fold a content line at 74 octets per RFC 5545 §3.1 (continuations get a
/// leading space). Splits on char boundaries, so multi-byte text stays valid.
pub(crate) fn fold(line: &str, out: &mut String) {
    const LIMIT: usize = 74;
    let mut budget = LIMIT;
    let mut used = 0;
    for c in line.chars() {
        let w = c.len_utf8();
        if used + w > budget {
            out.push_str("\r\n ");
            budget = LIMIT - 1;
            used = 0;
        }
        out.push(c);
        used += w;
    }
    out.push_str("\r\n");
}

pub(crate) fn push_prop(out: &mut String, key: &str, value: &str) {
    fold(&format!("{key}:{value}"), out);
}

/// Details for an outbound invite (METHOD:REQUEST).
pub struct InviteSpec<'a> {
    pub uid: &'a str,
    pub sequence: i64,
    pub summary: &'a str,
    pub description: Option<&'a str>,
    pub location: Option<&'a str>,
    pub join_url: Option<&'a str>,
    pub organizer: &'a Address,
    pub attendees: &'a [Address],
    pub starts_at_ms: i64,
    pub ends_at_ms: i64,
    pub dtstamp_ms: i64,
}

fn calendar_shell(method: &str, body: impl FnOnce(&mut String)) -> String {
    let mut out = String::new();
    push_prop(&mut out, "BEGIN", "VCALENDAR");
    push_prop(&mut out, "PRODID", "-//Comail//Comail Calendar//EN");
    push_prop(&mut out, "VERSION", "2.0");
    push_prop(&mut out, "METHOD", method);
    push_prop(&mut out, "BEGIN", "VEVENT");
    body(&mut out);
    push_prop(&mut out, "END", "VEVENT");
    push_prop(&mut out, "END", "VCALENDAR");
    out
}

/// Encode a parameter value per RFC 5545 §3.2: quote when it contains
/// characters that would break the property line (quotes themselves are
/// disallowed in param values, so they are dropped).
fn param_value(v: &str) -> String {
    let clean: String = v.chars().filter(|c| *c != '"').collect();
    if clean.contains([',', ';', ':']) {
        format!("\"{clean}\"")
    } else {
        clean
    }
}

fn organizer_prop(out: &mut String, addr: &Address) {
    match &addr.name {
        Some(n) if !n.is_empty() => fold(
            &format!("ORGANIZER;CN={}:mailto:{}", param_value(n), addr.email),
            out,
        ),
        _ => fold(&format!("ORGANIZER:mailto:{}", addr.email), out),
    }
}

/// Build a METHOD:REQUEST calendar for a new meeting invite.
pub fn build_request_ics(spec: &InviteSpec) -> String {
    calendar_shell("REQUEST", |out| {
        push_prop(out, "UID", spec.uid);
        push_prop(out, "DTSTAMP", &fmt_utc(spec.dtstamp_ms));
        push_prop(out, "SEQUENCE", &spec.sequence.to_string());
        push_prop(out, "DTSTART", &fmt_utc(spec.starts_at_ms));
        push_prop(out, "DTEND", &fmt_utc(spec.ends_at_ms));
        push_prop(out, "SUMMARY", &escape(spec.summary));
        if let Some(loc) = spec.location {
            push_prop(out, "LOCATION", &escape(loc));
        }
        let desc = match (spec.description, spec.join_url) {
            (Some(d), Some(u)) => Some(format!("{d}\n\n{u}")),
            (Some(d), None) => Some(d.to_string()),
            (None, Some(u)) => Some(u.to_string()),
            (None, None) => None,
        };
        if let Some(d) = &desc {
            push_prop(out, "DESCRIPTION", &escape(d));
        }
        if let Some(u) = spec.join_url {
            push_prop(out, "URL", u);
        }
        push_prop(out, "STATUS", "CONFIRMED");
        organizer_prop(out, spec.organizer);
        for a in spec.attendees {
            let cn = a
                .name
                .as_deref()
                .filter(|n| !n.is_empty())
                .map(|n| format!("CN={};", param_value(n)))
                .unwrap_or_default();
            fold(
                &format!(
                    "ATTENDEE;{cn}ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:{}",
                    a.email
                ),
                out,
            );
        }
    })
}

/// Build a METHOD:CANCEL calendar revoking a meeting we organize. SEQUENCE
/// must be higher than the last one sent so clients accept the cancellation.
pub fn build_cancel_ics(spec: &InviteSpec) -> String {
    calendar_shell("CANCEL", |out| {
        push_prop(out, "UID", spec.uid);
        push_prop(out, "DTSTAMP", &fmt_utc(spec.dtstamp_ms));
        push_prop(out, "SEQUENCE", &spec.sequence.to_string());
        push_prop(out, "DTSTART", &fmt_utc(spec.starts_at_ms));
        push_prop(out, "DTEND", &fmt_utc(spec.ends_at_ms));
        push_prop(out, "SUMMARY", &escape(spec.summary));
        push_prop(out, "STATUS", "CANCELLED");
        organizer_prop(out, spec.organizer);
        for a in spec.attendees {
            fold(&format!("ATTENDEE:mailto:{}", a.email), out);
        }
    })
}

/// Details for an RSVP reply (METHOD:REPLY).
pub struct ReplySpec<'a> {
    pub uid: &'a str,
    pub sequence: i64,
    pub summary: Option<&'a str>,
    /// ACCEPTED | TENTATIVE | DECLINED
    pub partstat: &'a str,
    pub organizer_email: &'a str,
    pub attendee: &'a Address,
    pub starts_at_ms: i64,
    pub ends_at_ms: Option<i64>,
    pub dtstamp_ms: i64,
}

/// Build a METHOD:REPLY calendar answering an invite.
pub fn build_reply_ics(spec: &ReplySpec) -> String {
    calendar_shell("REPLY", |out| {
        push_prop(out, "UID", spec.uid);
        push_prop(out, "DTSTAMP", &fmt_utc(spec.dtstamp_ms));
        push_prop(out, "SEQUENCE", &spec.sequence.to_string());
        push_prop(out, "DTSTART", &fmt_utc(spec.starts_at_ms));
        if let Some(end) = spec.ends_at_ms {
            push_prop(out, "DTEND", &fmt_utc(end));
        }
        if let Some(s) = spec.summary {
            push_prop(out, "SUMMARY", &escape(s));
        }
        fold(
            &format!("ORGANIZER:mailto:{}", spec.organizer_email),
            out,
        );
        let cn = spec
            .attendee
            .name
            .as_deref()
            .filter(|n| !n.is_empty())
            .map(|n| format!("CN={};", param_value(n)))
            .unwrap_or_default();
        fold(
            &format!(
                "ATTENDEE;{cn}PARTSTAT={}:mailto:{}",
                spec.partstat, spec.attendee.email
            ),
            out,
        );
    })
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

    #[test]
    fn parses_attendees_description_and_meet_link() {
        let ics = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:evt-3\r\nSUMMARY:Sync\r\nDESCRIPTION:Agenda\\nJoin: https://meet.google.com/abc-defg-hij\r\nATTENDEE;CN=\"Bob B\";PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bob@example.com\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:carol@example.com\r\nSEQUENCE:2\r\nDTSTART:20260720T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
        let ev = &parse_ics(ics)[0];
        assert_eq!(ev.description.as_deref(), Some("Agenda\nJoin: https://meet.google.com/abc-defg-hij"));
        assert_eq!(ev.sequence, 2);
        assert_eq!(ev.attendees.len(), 2);
        assert_eq!(ev.attendees[0].email, "bob@example.com");
        assert_eq!(ev.attendees[0].name.as_deref(), Some("Bob B"));
        assert_eq!(ev.attendees[1].partstat.as_deref(), Some("ACCEPTED"));
        assert_eq!(ev.join_url.as_deref(), Some("https://meet.google.com/abc-defg-hij"));
    }

    #[test]
    fn finds_zoom_url_in_location() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:evt-4\r\nLOCATION:https://acme.zoom.us/j/123456?pwd=x\r\nDTSTART:20260720T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
        assert_eq!(
            parse_ics(ics)[0].join_url.as_deref(),
            Some("https://acme.zoom.us/j/123456?pwd=x")
        );
        assert_eq!(find_join_url("call me at https://example.com/x"), None);
    }

    #[test]
    fn request_roundtrips_through_parser() {
        let organizer = Address { name: Some("Dean".into()), email: "bd@northbeam.com".into() };
        let attendees = vec![
            Address { name: Some("Bob, Jr.".into()), email: "bob@example.com".into() },
            Address { name: None, email: "carol@example.com".into() },
        ];
        let ics = build_request_ics(&InviteSpec {
            uid: "abc-123@comail",
            sequence: 0,
            summary: "Planning; H2, kickoff",
            description: Some("Line one\nline two"),
            location: Some("Room 9"),
            join_url: Some("https://meet.google.com/xyz"),
            organizer: &organizer,
            attendees: &attendees,
            starts_at_ms: 1_784_124_000_000,
            ends_at_ms: 1_784_127_600_000,
            dtstamp_ms: 1_784_000_000_000,
        });
        let evs = parse_ics(&ics);
        assert_eq!(evs.len(), 1);
        let ev = &evs[0];
        assert_eq!(ev.method.as_deref(), Some("REQUEST"));
        assert_eq!(ev.uid, "abc-123@comail");
        assert_eq!(ev.summary.as_deref(), Some("Planning; H2, kickoff"));
        assert_eq!(ev.location.as_deref(), Some("Room 9"));
        assert_eq!(ev.organizer.as_deref(), Some("bd@northbeam.com"));
        assert_eq!(ev.starts_at_ms, 1_784_124_000_000);
        assert_eq!(ev.ends_at_ms, Some(1_784_127_600_000));
        assert_eq!(ev.join_url.as_deref(), Some("https://meet.google.com/xyz"));
        assert_eq!(ev.attendees.len(), 2);
        assert_eq!(ev.attendees[0].name.as_deref(), Some("Bob, Jr."));
        assert_eq!(ev.attendees[0].partstat.as_deref(), Some("NEEDS-ACTION"));
        // every line respects the 75-octet cap
        for line in ics.lines() {
            assert!(line.len() <= 75, "line too long: {line}");
        }
    }

    #[test]
    fn reply_roundtrips_through_parser() {
        let me = Address { name: None, email: "bd@northbeam.com".into() };
        let ics = build_reply_ics(&ReplySpec {
            uid: "evt-1@cal.example.com",
            sequence: 1,
            summary: Some("Design review"),
            partstat: "ACCEPTED",
            organizer_email: "alice@example.com",
            attendee: &me,
            starts_at_ms: 1_784_124_000_000,
            ends_at_ms: None,
            dtstamp_ms: 1_784_000_000_000,
        });
        let ev = &parse_ics(&ics)[0];
        assert_eq!(ev.method.as_deref(), Some("REPLY"));
        assert_eq!(ev.attendees[0].partstat.as_deref(), Some("ACCEPTED"));
        assert_eq!(ev.attendees[0].email, "bd@northbeam.com");
    }
}
