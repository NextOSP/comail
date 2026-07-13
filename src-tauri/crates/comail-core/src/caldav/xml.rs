//! WebDAV 207 multistatus parsing (namespace-agnostic: servers use `D:`,
//! `d:`, default namespaces, `C:`/`caldav:` interchangeably, so elements are
//! matched by local name only) plus the small XML request bodies we send.

use crate::error::Result;
use quick_xml::events::Event;
use quick_xml::Reader;

use super::err;

/// One <response> inside a multistatus.
#[derive(Debug, Clone, Default)]
pub struct DavItem {
    pub href: String,
    /// Per-response status ("HTTP/1.1 404 Not Found" -> 404); 200 when only
    /// propstat statuses are present and one of them is 2xx.
    pub status: u16,
    pub etag: Option<String>,
    pub calendar_data: Option<String>,
    // -- discovery props --
    pub displayname: Option<String>,
    pub color: Option<String>,
    pub current_user_principal: Option<String>,
    pub calendar_home_set: Option<String>,
    pub is_calendar: bool,
    pub supports_vevent: bool,
    /// whether a supported-calendar-component-set was present at all (absent
    /// means the server didn't say; treat as VEVENT-capable)
    pub saw_component_set: bool,
    pub ctag: Option<String>,
    pub sync_token: Option<String>,
}

/// The whole multistatus: items + top-level sync-token (RFC 6578).
#[derive(Debug, Clone, Default)]
pub struct Multistatus {
    pub items: Vec<DavItem>,
    pub sync_token: Option<String>,
}

fn local_name(qname: &[u8]) -> String {
    let s = String::from_utf8_lossy(qname);
    s.rsplit(':').next().unwrap_or(&s).to_ascii_lowercase()
}

fn parse_status_line(s: &str) -> u16 {
    s.split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0)
}

/// Parse a 207 body. Tolerant by design: unknown elements are skipped, text
/// is collected per element, and element identity ignores prefixes.
pub fn parse_multistatus(body: &str) -> Result<Multistatus> {
    let mut reader = Reader::from_str(body);
    reader.config_mut().trim_text(true);

    let mut out = Multistatus::default();
    let mut cur: Option<DavItem> = None;
    // Element path of local names, so we can tell response-level <status>
    // from propstat-level, and top-level sync-token from an item's.
    let mut path: Vec<String> = Vec::new();
    let mut text = String::new();
    // Inside <current-user-principal>/<calendar-home-set>, the value is an
    // <href>; track which wrapper we're in.
    let mut href_target: Option<&'static str> = None;
    let mut propstat_status: u16 = 0;
    let mut buf = Vec::new();

    loop {
        match reader
            .read_event_into(&mut buf)
            .map_err(|e| err(format!("xml: {e}")))?
        {
            Event::Start(e) => {
                let name = local_name(e.name().as_ref());
                match name.as_str() {
                    "response" => {
                        cur = Some(DavItem::default());
                        propstat_status = 0;
                    }
                    "current-user-principal" => href_target = Some("principal"),
                    "calendar-home-set" => href_target = Some("home"),
                    "resourcetype" => {}
                    "supported-calendar-component-set" => {
                        if let Some(item) = cur.as_mut() {
                            item.saw_component_set = true;
                        }
                    }
                    _ => {}
                }
                path.push(name);
                text.clear();
            }
            Event::Empty(e) => {
                let name = local_name(e.name().as_ref());
                match name.as_str() {
                    "calendar" if path.last().is_some_and(|p| p == "resourcetype") => {
                        if let Some(item) = cur.as_mut() {
                            item.is_calendar = true;
                        }
                    }
                    "comp" => {
                        // <C:comp name="VEVENT"/>
                        if let Some(item) = cur.as_mut() {
                            for attr in e.attributes().flatten() {
                                if local_name(attr.key.as_ref()) == "name"
                                    && attr.value.eq_ignore_ascii_case(b"VEVENT")
                                {
                                    item.supports_vevent = true;
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Event::Text(t) => {
                text.push_str(&t.unescape().map_err(|e| err(format!("xml text: {e}")))?);
            }
            Event::CData(t) => {
                text.push_str(&String::from_utf8_lossy(&t.into_inner()));
            }
            Event::End(e) => {
                let name = local_name(e.name().as_ref());
                path.pop();
                let value = text.trim().to_string();
                text.clear();
                match name.as_str() {
                    "response" => {
                        if let Some(mut item) = cur.take() {
                            if item.status == 0 {
                                item.status = if propstat_status != 0 {
                                    propstat_status
                                } else {
                                    200
                                };
                            }
                            out.items.push(item);
                        }
                    }
                    "href" => {
                        if let Some(item) = cur.as_mut() {
                            match href_target {
                                Some("principal") => {
                                    item.current_user_principal = Some(value);
                                }
                                Some("home") => item.calendar_home_set = Some(value),
                                _ => {
                                    if item.href.is_empty() {
                                        item.href = value;
                                    }
                                }
                            }
                        }
                    }
                    "current-user-principal" | "calendar-home-set" => href_target = None,
                    "status" => {
                        let code = parse_status_line(&value);
                        // <status> directly under <response> is the item's
                        // status (sync-collection 404s); under <propstat> it
                        // qualifies the props.
                        if path.last().is_some_and(|p| p == "response") {
                            if let Some(item) = cur.as_mut() {
                                item.status = code;
                            }
                        } else if (200..300).contains(&code) || propstat_status == 0 {
                            propstat_status = code;
                        }
                    }
                    "getetag" => {
                        if let Some(item) = cur.as_mut() {
                            item.etag = Some(value);
                        }
                    }
                    "calendar-data" => {
                        if let Some(item) = cur.as_mut() {
                            item.calendar_data = Some(value);
                        }
                    }
                    "displayname" => {
                        if let Some(item) = cur.as_mut() {
                            if !value.is_empty() {
                                item.displayname = Some(value);
                            }
                        }
                    }
                    "calendar-color" => {
                        if let Some(item) = cur.as_mut() {
                            if !value.is_empty() {
                                item.color = Some(value);
                            }
                        }
                    }
                    "getctag" => {
                        if let Some(item) = cur.as_mut() {
                            item.ctag = Some(value);
                        }
                    }
                    "sync-token" => {
                        if let Some(item) = cur.as_mut() {
                            item.sync_token = Some(value.clone());
                        } else {
                            out.sync_token = Some(value);
                        }
                    }
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

impl DavItem {
    /// A collection we can sync VEVENTs with.
    pub fn is_vevent_calendar(&self) -> bool {
        self.is_calendar && (self.supports_vevent || !self.saw_component_set)
    }
}

// ---------- request bodies (we control these; templates are fine) ----------

pub fn propfind_principal() -> String {
    r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/><d:resourcetype/></d:prop></d:propfind>"#
        .into()
}

pub fn propfind_home_set() -> String {
    r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>"#
        .into()
}

pub fn propfind_collections() -> String {
    r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/">
<d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/><cs:getctag/><d:sync-token/><d:current-user-privilege-set/></d:prop>
</d:propfind>"#
        .into()
}

pub fn propfind_ctag() -> String {
    r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><cs:getctag/><d:sync-token/></d:prop></d:propfind>"#
        .into()
}

pub fn report_sync_collection(token: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<d:sync-collection xmlns:d="DAV:"><d:sync-token>{}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>"#,
        xml_escape(token)
    )
}

/// Lists every VEVENT resource in a collection (etags only). Deliberately
/// unbounded: a time-range filter would leave events outside the window
/// unsynced forever, since the incremental sync-collection pass that follows
/// only ever reports *changes* to what the initial pull already saw.
pub fn report_calendar_query() -> String {
    r#"<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
<d:prop><d:getetag/></d:prop>
<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter>
</c:calendar-query>"#
        .into()
}

pub fn report_multiget(hrefs: &[String]) -> String {
    let hrefs_xml: String = hrefs
        .iter()
        .map(|h| format!("<d:href>{}</d:href>", xml_escape(h)))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
<d:prop><d:getetag/><c:calendar-data/></d:prop>{hrefs_xml}
</c:calendar-multiget>"#
    )
}

pub fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Google style: `D:` prefixes, principal discovery.
    const GOOGLE_PRINCIPAL: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
 <D:response>
  <D:href>/caldav/v2/</D:href>
  <D:propstat>
   <D:status>HTTP/1.1 200 OK</D:status>
   <D:prop>
    <D:current-user-principal><D:href>/caldav/v2/bd%40nextwaves.com/user</D:href></D:current-user-principal>
    <D:resourcetype><D:principal/></D:resourcetype>
   </D:prop>
  </D:propstat>
 </D:response>
</D:multistatus>"#;

    /// SabreDAV style: default `d:`/`cal:` prefixes, collection listing.
    const SABRE_COLLECTIONS: &str = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:x1="http://apple.com/ns/ical/">
 <d:response>
  <d:href>/dav/calendars/user/me/</d:href>
  <d:propstat>
   <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
 <d:response>
  <d:href>/dav/calendars/user/me/default/</d:href>
  <d:propstat>
   <d:prop>
    <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
    <d:displayname>Personal</d:displayname>
    <x1:calendar-color>#3B87E0FF</x1:calendar-color>
    <cal:supported-calendar-component-set><cal:comp name="VEVENT"/><cal:comp name="VTODO"/></cal:supported-calendar-component-set>
    <cs:getctag>ctag-123</cs:getctag>
    <d:sync-token>http://sabre.io/ns/sync/55</d:sync-token>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
 <d:response>
  <d:href>/dav/calendars/user/me/tasks/</d:href>
  <d:propstat>
   <d:prop>
    <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
    <d:displayname>Tasks</d:displayname>
    <cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>"#;

    /// Fastmail/Cyrus style sync-collection response with a 404 removal.
    const CYRUS_SYNC: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
 <D:response>
  <D:href>/dav/calendars/user/me/default/abc.ics</D:href>
  <D:propstat>
   <D:prop><D:getetag>"e-1"</D:getetag></D:prop>
   <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
 </D:response>
 <D:response>
  <D:href>/dav/calendars/user/me/default/gone.ics</D:href>
  <D:status>HTTP/1.1 404 Not Found</D:status>
 </D:response>
 <D:sync-token>data:,sync-99</D:sync-token>
</D:multistatus>"#;

    const MULTIGET: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
 <d:response>
  <d:href>/cal/abc.ics</d:href>
  <d:propstat>
   <d:prop>
    <d:getetag>"e-2"</d:getetag>
    <c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:abc@server
SUMMARY:Fetched &amp; parsed
DTSTART:20260720T090000Z
END:VEVENT
END:VCALENDAR</c:calendar-data>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>"#;

    #[test]
    fn parses_google_principal() {
        let ms = parse_multistatus(GOOGLE_PRINCIPAL).unwrap();
        assert_eq!(ms.items.len(), 1);
        assert_eq!(
            ms.items[0].current_user_principal.as_deref(),
            Some("/caldav/v2/bd%40nextwaves.com/user")
        );
        assert_eq!(ms.items[0].href, "/caldav/v2/");
        assert_eq!(ms.items[0].status, 200);
    }

    #[test]
    fn parses_sabre_collections() {
        let ms = parse_multistatus(SABRE_COLLECTIONS).unwrap();
        assert_eq!(ms.items.len(), 3);
        let home = &ms.items[0];
        assert!(!home.is_calendar);
        let cal = &ms.items[1];
        assert!(cal.is_calendar);
        assert!(cal.supports_vevent);
        assert_eq!(cal.displayname.as_deref(), Some("Personal"));
        assert_eq!(cal.color.as_deref(), Some("#3B87E0FF"));
        assert_eq!(cal.ctag.as_deref(), Some("ctag-123"));
        assert_eq!(
            cal.sync_token.as_deref(),
            Some("http://sabre.io/ns/sync/55")
        );
        let tasks = &ms.items[2];
        assert!(tasks.is_calendar);
        assert!(!tasks.supports_vevent); // VTODO-only collection filtered out
        assert!(cal.is_vevent_calendar());
        assert!(!tasks.is_vevent_calendar());
        assert!(!home.is_vevent_calendar());
    }

    #[test]
    fn parses_sync_collection_with_removal() {
        let ms = parse_multistatus(CYRUS_SYNC).unwrap();
        assert_eq!(ms.sync_token.as_deref(), Some("data:,sync-99"));
        assert_eq!(ms.items.len(), 2);
        assert_eq!(ms.items[0].status, 200);
        assert_eq!(ms.items[0].etag.as_deref(), Some("\"e-1\""));
        assert_eq!(ms.items[1].status, 404);
        assert!(ms.items[1].href.ends_with("gone.ics"));
    }

    #[test]
    fn parses_multiget_calendar_data() {
        let ms = parse_multistatus(MULTIGET).unwrap();
        let item = &ms.items[0];
        assert_eq!(item.etag.as_deref(), Some("\"e-2\""));
        let ics = item.calendar_data.as_deref().unwrap();
        assert!(ics.contains("SUMMARY:Fetched & parsed"));
        let events = crate::calendar::parse_ics(ics);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].uid, "abc@server");
    }

    #[test]
    fn request_bodies_are_wellformed() {
        for body in [
            propfind_principal(),
            propfind_home_set(),
            propfind_collections(),
            propfind_ctag(),
            report_sync_collection("tok&<>"),
            report_calendar_query(),
            report_multiget(&["/a b.ics".into(), "/c&d.ics".into()]),
        ] {
            let mut reader = Reader::from_str(&body);
            let mut buf = Vec::new();
            loop {
                match reader.read_event_into(&mut buf) {
                    Ok(Event::Eof) => break,
                    Ok(_) => {}
                    Err(e) => panic!("malformed request body: {e}\n{body}"),
                }
                buf.clear();
            }
        }
    }
}
