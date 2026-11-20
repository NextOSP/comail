//! Bootstrap: from a server URL to the user's address books.
//! current-user-principal -> addressbook-home-set -> Depth:1 listing
//! (RFC 6352 §7), with the same shortcuts as CalDAV: a pasted URL that
//! already is an address book is used directly, and a bare host tries
//! /.well-known/carddav (RFC 6764).

use crate::caldav::discovery::{propfind, resolve};
use crate::caldav::{Transport, xml};
use crate::error::{CoreError, Result};

use super::{as_carddav, err};

#[derive(Debug, Clone)]
pub struct DiscoveredBook {
    /// Absolute collection URL.
    pub url: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Discovery {
    pub principal_url: Option<String>,
    pub home_set_url: String,
    pub books: Vec<DiscoveredBook>,
}

/// Full discovery from `base_url`. Doubles as the connection test: it
/// succeeds only with at least one address book.
pub async fn discover(t: &dyn Transport, base_url: &str) -> Result<Discovery> {
    discover_inner(t, base_url).await.map_err(as_carddav)
}

async fn discover_inner(t: &dyn Transport, base_url: &str) -> Result<Discovery> {
    // Shortcut: the URL is itself an address book.
    if let Ok(ms) = propfind(t, base_url, "0", xml::propfind_addressbooks()).await
        && let Some(item) = ms.items.first().filter(|i| i.is_addressbook)
    {
        return Ok(Discovery {
            principal_url: None,
            home_set_url: base_url.to_string(),
            books: vec![DiscoveredBook {
                url: base_url.to_string(),
                display_name: item.displayname.clone(),
            }],
        });
    }

    // Find the principal: the given URL first, then /.well-known/carddav.
    let mut principal: Option<String> = None;
    for candidate in [
        base_url.to_string(),
        resolve(base_url, "/.well-known/carddav")?,
    ] {
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
            Err(CoreError::NeedsReauth) => return Err(CoreError::NeedsReauth),
            Err(_) => continue,
        }
    }
    let principal = principal.ok_or_else(|| err("no current-user-principal found"))?;

    // Principal -> address book home set.
    let ms = propfind(t, &principal, "0", xml::propfind_addressbook_home_set()).await?;
    let home = ms
        .items
        .iter()
        .find_map(|i| i.addressbook_home_set.clone())
        .ok_or_else(|| err("no addressbook-home-set on principal (is this a CardDAV server?)"))?;
    let home = resolve(&principal, &home)?;

    // Home set -> address books.
    let ms = propfind(t, &home, "1", xml::propfind_addressbooks()).await?;
    let books: Vec<DiscoveredBook> = ms
        .items
        .iter()
        .filter(|i| i.is_addressbook && !i.href.is_empty())
        .map(|i| {
            Ok(DiscoveredBook {
                url: resolve(&home, &i.href)?,
                display_name: i.displayname.clone(),
            })
        })
        .collect::<Result<_>>()?;

    if books.is_empty() {
        return Err(err("no address books found on the server"));
    }
    Ok(Discovery {
        principal_url: Some(principal),
        home_set_url: home,
        books,
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

    fn status(code: u16) -> DavResponse {
        DavResponse {
            status: code,
            etag: None,
            body: String::new(),
        }
    }

    const NOT_A_BOOK: &str = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
    const PRINCIPAL: &str = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/.well-known/carddav</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/users/me/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
    const HOME: &str = r#"<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:response><d:href>/principals/users/me/</d:href><d:propstat><d:prop><card:addressbook-home-set><d:href>/addressbooks/users/me/</d:href></card:addressbook-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
    const BOOKS: &str = r#"<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:response><d:href>/addressbooks/users/me/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/addressbooks/users/me/contacts/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>Contacts</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>https://dav.example.com/addressbooks/users/me/shared/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;

    #[tokio::test]
    async fn walks_well_known_principal_home_and_listing() {
        let t = MockTransport::new(vec![
            ms(NOT_A_BOOK), // direct-book probe
            status(404),    // the URL itself has no principal (not 207)
            ms(PRINCIPAL),  // /.well-known/carddav
            ms(HOME),
            ms(BOOKS),
        ]);
        let d = discover(&t, "https://dav.example.com/").await.unwrap();
        assert_eq!(
            d.principal_url.as_deref(),
            Some("https://dav.example.com/principals/users/me/")
        );
        assert_eq!(
            d.home_set_url,
            "https://dav.example.com/addressbooks/users/me/"
        );
        let urls: Vec<&str> = d.books.iter().map(|b| b.url.as_str()).collect();
        assert_eq!(
            urls,
            [
                "https://dav.example.com/addressbooks/users/me/contacts/",
                "https://dav.example.com/addressbooks/users/me/shared/"
            ]
        );
        assert_eq!(d.books[0].display_name.as_deref(), Some("Contacts"));

        let seen = t.seen.lock().unwrap();
        assert_eq!(seen[2].1, "https://dav.example.com/.well-known/carddav");
        assert!(
            seen[3]
                .2
                .as_deref()
                .unwrap()
                .contains("addressbook-home-set")
        );
    }

    #[tokio::test]
    async fn pasted_address_book_url_is_used_directly() {
        let direct = r#"<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:response><d:href>/ab/me/default/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>Default</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
        let t = MockTransport::new(vec![ms(direct)]);
        let d = discover(&t, "https://dav.example.com/ab/me/default/")
            .await
            .unwrap();
        assert_eq!(d.books.len(), 1);
        assert_eq!(d.books[0].url, "https://dav.example.com/ab/me/default/");
    }

    #[tokio::test]
    async fn calendar_only_server_is_a_carddav_error() {
        let home_without_books = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/principals/me/</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
        let t = MockTransport::new(vec![ms(NOT_A_BOOK), ms(PRINCIPAL), ms(home_without_books)]);
        let e = discover(&t, "https://dav.example.com/").await.unwrap_err();
        assert_eq!(e.code(), "carddav");
    }
}
