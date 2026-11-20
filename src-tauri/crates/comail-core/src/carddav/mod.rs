//! Read-only CardDAV contact sync (RFC 6352): discovery from a server URL to
//! the user's address books, then per-book pulls through sync-collection
//! (RFC 6578) or, without a sync token, a PROPFIND etag listing, fetching
//! changed vCards with addressbook-multiget. Nothing is written back to the
//! server.
//!
//! The WebDAV plumbing (HTTP transport, multistatus parser, href helpers) is
//! shared with [`crate::caldav`].

pub mod discovery;
pub mod sync;
pub mod task;
pub mod vcard;

use crate::error::CoreError;

pub fn err(msg: impl Into<String>) -> CoreError {
    CoreError::CardDav(msg.into())
}

/// Failures from the shared WebDAV layer read as CardDAV errors here.
pub(crate) fn as_carddav(e: CoreError) -> CoreError {
    match e {
        CoreError::CalDav(m) => CoreError::CardDav(m),
        other => other,
    }
}

/// A typed server URL, trimmed, with https:// assumed when no scheme is given.
pub fn normalize_url(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    Some(if url.contains("://") {
        url.to_string()
    } else {
        format!("https://{url}")
    })
}

/// Lowercased host of a server URL (https:// assumed when missing).
pub fn host_of(url: &str) -> Option<String> {
    let url = url::Url::parse(&normalize_url(url)?).ok()?;
    url.host_str().map(str::to_ascii_lowercase)
}

/// Whether a login that works on `known` may be offered for `host`: the same
/// host, one inside the other (`dav.example.com` / `example.com`), or
/// siblings under one parent domain (Fastmail's `caldav.` / `carddav.`,
/// iCloud's `p42-caldav.` / `contacts.`).
pub fn same_server(host: &str, known: &str) -> bool {
    if host.eq_ignore_ascii_case(known) {
        return true;
    }
    let (host, known) = (host.to_ascii_lowercase(), known.to_ascii_lowercase());
    // A bare TLD or IP octets never make a meaningful parent.
    let is_domain = |d: &str| d.contains('.') && !d.chars().all(|c| c.is_ascii_digit() || c == '.');
    let inside =
        |inner: &str, outer: &str| is_domain(outer) && inner.ends_with(&format!(".{outer}"));
    if inside(&host, &known) || inside(&known, &host) {
        return true;
    }
    let parent = |h: &str| h.split_once('.').map(|(_, rest)| rest.to_string());
    matches!((parent(&host), parent(&known)), (Some(a), Some(b)) if a == b && is_domain(&a))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_typed_urls() {
        assert_eq!(normalize_url("  "), None);
        assert_eq!(
            normalize_url(" dav.example.com/ ").as_deref(),
            Some("https://dav.example.com/")
        );
        assert_eq!(
            host_of("HTTP://Cloud.Example.org:8443/remote.php/dav").as_deref(),
            Some("cloud.example.org")
        );
        assert_eq!(host_of("").as_deref(), None);
    }

    #[test]
    fn same_server_matches_hosts_of_one_provider() {
        assert!(same_server("cloud.example.org", "cloud.example.org"));
        assert!(same_server("carddav.fastmail.com", "caldav.fastmail.com"));
        assert!(same_server("contacts.icloud.com", "p42-caldav.icloud.com"));
        assert!(same_server("dav.example.com", "example.com"));
        assert!(!same_server("dav.example.com", "dav.example.net"));
        assert!(!same_server("a.com", "b.com"));
        assert!(!same_server("192.168.1.10", "192.168.1.11"));
        assert!(!same_server("example.com", "com"));
    }
}
