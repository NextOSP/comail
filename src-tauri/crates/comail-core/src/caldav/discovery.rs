//! Bootstrap: from a base URL to the list of VEVENT-capable collections.
//! current-user-principal -> calendar-home-set -> Depth:1 listing (RFC 4791),
//! with two shortcuts: a pasted URL that already is a calendar collection is
//! used directly, and a bare host tries /.well-known/caldav (RFC 6764).

use url::Url;

use super::xml;
use super::{err, Transport};
use crate::error::Result;

#[derive(Debug, Clone)]
pub struct DiscoveredCalendar {
    /// Absolute collection URL.
    pub url: String,
    pub display_name: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Discovery {
    pub principal_url: Option<String>,
    pub home_set_url: String,
    pub calendars: Vec<DiscoveredCalendar>,
}

/// Resolve a (possibly relative) href against the URL it came from.
pub fn resolve(base: &str, href: &str) -> Result<String> {
    let base = Url::parse(base).map_err(|e| err(format!("bad url {base}: {e}")))?;
    let joined = base
        .join(href)
        .map_err(|e| err(format!("bad href {href}: {e}")))?;
    Ok(joined.to_string())
}

async fn propfind(
    t: &dyn Transport,
    url: &str,
    depth: &str,
    body: String,
) -> Result<xml::Multistatus> {
    let resp = t.request("PROPFIND", url, Some(depth), &[], Some(body)).await?;
    if resp.status != 207 {
        return Err(err(format!("PROPFIND {url}: HTTP {}", resp.status)));
    }
    xml::parse_multistatus(&resp.body)
}

/// Full discovery from `base_url`. Connection test = this succeeding with at
/// least one usable collection.
pub async fn discover(t: &dyn Transport, base_url: &str) -> Result<Discovery> {
    // Shortcut: the URL is itself a calendar collection.
    if let Ok(ms) = propfind(t, base_url, "0", xml::propfind_collections()).await {
        if let Some(item) = ms.items.first() {
            if item.is_vevent_calendar() {
                return Ok(Discovery {
                    principal_url: None,
                    home_set_url: base_url.to_string(),
                    calendars: vec![DiscoveredCalendar {
                        url: base_url.to_string(),
                        display_name: item.displayname.clone(),
                        color: item.color.clone(),
                    }],
                });
            }
        }
    }

    // Find the principal: the given URL first, then /.well-known/caldav.
    let mut principal: Option<String> = None;
    for candidate in [base_url.to_string(), resolve(base_url, "/.well-known/caldav")?] {
        match propfind(t, &candidate, "0", xml::propfind_principal()).await {
            Ok(ms) => {
                if let Some(p) = ms
                    .items
                    .iter()
                    .find_map(|i| i.current_user_principal.clone())
                {
                    principal = Some(resolve(&candidate, &p)?);
                    break;
                }
            }
            Err(crate::error::CoreError::NeedsReauth) => {
                return Err(crate::error::CoreError::NeedsReauth)
            }
            Err(_) => continue,
        }
    }
    let principal = principal.ok_or_else(|| err("no current-user-principal found"))?;

    // Principal -> calendar home set.
    let ms = propfind(t, &principal, "0", xml::propfind_home_set()).await?;
    let home = ms
        .items
        .iter()
        .find_map(|i| i.calendar_home_set.clone())
        .ok_or_else(|| err("no calendar-home-set on principal"))?;
    let home = resolve(&principal, &home)?;

    // Home set -> collections.
    let ms = propfind(t, &home, "1", xml::propfind_collections()).await?;
    let calendars: Vec<DiscoveredCalendar> = ms
        .items
        .iter()
        .filter(|i| i.is_vevent_calendar() && !i.href.is_empty())
        .map(|i| {
            Ok(DiscoveredCalendar {
                url: resolve(&home, &i.href)?,
                display_name: i.displayname.clone(),
                color: i.color.clone(),
            })
        })
        .collect::<Result<_>>()?;

    if calendars.is_empty() {
        return Err(err("no calendars found on the server"));
    }
    Ok(Discovery {
        principal_url: Some(principal),
        home_set_url: home,
        calendars,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caldav::http::{DavResponse, MockTransport};

    fn ms(body: &str) -> DavResponse {
        DavResponse {
            status: 207,
            etag: None,
            body: body.into(),
        }
    }

    const PRINCIPAL: &str = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
    const HOME: &str = r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principals/me/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/cal/me/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
    const COLLECTIONS: &str = r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/me/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/cal/me/work/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Work</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
    const NOT_A_CALENDAR: &str = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;

    #[tokio::test]
    async fn full_discovery_chain() {
        let t = MockTransport::new(vec![
            ms(NOT_A_CALENDAR), // direct-collection probe: not a calendar
            ms(PRINCIPAL),
            ms(HOME),
            ms(COLLECTIONS),
        ]);
        let d = discover(&t, "https://dav.example.com/").await.unwrap();
        assert_eq!(d.principal_url.as_deref(), Some("https://dav.example.com/principals/me/"));
        assert_eq!(d.home_set_url, "https://dav.example.com/cal/me/");
        assert_eq!(d.calendars.len(), 1);
        assert_eq!(d.calendars[0].url, "https://dav.example.com/cal/me/work/");
        assert_eq!(d.calendars[0].display_name.as_deref(), Some("Work"));
    }

    #[tokio::test]
    async fn direct_collection_shortcut() {
        let direct = r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/me/personal/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Personal</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
        let t = MockTransport::new(vec![ms(direct)]);
        let d = discover(&t, "https://dav.example.com/cal/me/personal/")
            .await
            .unwrap();
        assert_eq!(d.calendars.len(), 1);
        assert_eq!(d.calendars[0].url, "https://dav.example.com/cal/me/personal/");
    }
}
