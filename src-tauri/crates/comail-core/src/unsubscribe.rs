//! List unsubscribe mechanics: RFC 8058 one-click HTTPS POST, with RFC 2369
//! mailto: and plain-browser fallbacks.
//!
//! One-click (RFC 8058) requires the sender to publish BOTH
//! `List-Unsubscribe: <https://…>` and
//! `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; the receiver then
//! POSTs the literal body `List-Unsubscribe=One-Click` to the HTTPS URI.
//! The endpoint must complete the unsubscribe without cookies, logins or
//! redirects, so the client here carries no cookie store and treats any
//! non-2xx (including 3xx) as failure.

use crate::error::{CoreError, Result};
use crate::mime::{is_one_click_post, parse_unsubscribe_uris};
use std::time::Duration;

/// Which mechanism the message's headers support, in preference order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnsubscribePlan {
    /// HTTPS URI with a one-click List-Unsubscribe-Post marker.
    OneClick { url: String },
    /// mailto: fallback - send an unsubscribe request message.
    Mailto {
        to: String,
        subject: String,
        body: String,
    },
    /// Only a plain web URL: the user has to finish in the browser.
    Browser { url: String },
}

/// Decide how to unsubscribe from the raw header values. None when the header
/// contains no usable URI.
pub fn plan(
    list_unsubscribe: &str,
    list_unsubscribe_post: Option<&str>,
) -> Option<UnsubscribePlan> {
    let uris = parse_unsubscribe_uris(list_unsubscribe);
    let web = uris
        .iter()
        .find(|u| {
            let l = u.to_ascii_lowercase();
            l.starts_with("https://") || l.starts_with("http://")
        })
        .cloned();
    let one_click = list_unsubscribe_post.is_some_and(is_one_click_post);

    // RFC 8058 is https-only; a one-click marker on an http:// URI is ignored.
    if one_click
        && let Some(url) = web
            .as_deref()
            .filter(|u| u.to_ascii_lowercase().starts_with("https://"))
    {
        return Some(UnsubscribePlan::OneClick {
            url: url.to_string(),
        });
    }

    if let Some(m) = uris
        .iter()
        .find(|u| u.to_ascii_lowercase().starts_with("mailto:"))
        && let Some(p) = parse_mailto(m)
    {
        return Some(p);
    }

    web.map(|url| UnsubscribePlan::Browser { url })
}

/// Parse `mailto:addr?subject=…&body=…` into a Mailto plan. Subject defaults
/// to "unsubscribe" (the RFC 2369 convention); body to the subject text, so
/// list processors that only read the body still trigger.
fn parse_mailto(uri: &str) -> Option<UnsubscribePlan> {
    let rest = &uri[uri.find(':')? + 1..];
    let (addr, query) = match rest.split_once('?') {
        Some((a, q)) => (a, Some(q)),
        None => (rest, None),
    };
    let to = percent_decode(addr.trim());
    if to.is_empty() || !to.contains('@') {
        return None;
    }
    let mut subject = None;
    let mut body = None;
    for pair in query.unwrap_or("").split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k.to_ascii_lowercase().as_str() {
            "subject" => subject = Some(percent_decode(v)),
            "body" => body = Some(percent_decode(v)),
            _ => {}
        }
    }
    let subject = subject
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unsubscribe".into());
    let body = body
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| subject.clone());
    Some(UnsubscribePlan::Mailto { to, subject, body })
}

/// Minimal percent-decoding ('+' as space, %XX bytes, lossy UTF-8) - enough
/// for mailto query values without pulling in a URL crate.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 3 <= bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(hi), Some(lo)) => {
                        out.push((hi * 16 + lo) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Perform the RFC 8058 one-click POST. Success is a 2xx only: no redirects
/// are followed (the endpoint must not require them) and no cookies are sent.
pub async fn post_one_click(url: &str) -> Result<()> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("comail/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| CoreError::Network(e.to_string()))?;
    let resp = client
        .post(url)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body("List-Unsubscribe=One-Click")
        .send()
        .await
        .map_err(|e| CoreError::Network(e.to_string()))?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(CoreError::Network(format!(
            "one-click unsubscribe endpoint answered {status}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_click_needs_post_header_and_https() {
        let p = plan(
            "<https://x.example/u?t=1>, <mailto:u@x.example>",
            Some("List-Unsubscribe=One-Click"),
        );
        assert_eq!(
            p,
            Some(UnsubscribePlan::OneClick {
                url: "https://x.example/u?t=1".into()
            })
        );

        // Same header without the POST marker: mailto wins over browser.
        let p = plan("<https://x.example/u?t=1>, <mailto:u@x.example>", None);
        assert!(matches!(p, Some(UnsubscribePlan::Mailto { .. })));

        // One-click marker on a plain http URL is ignored.
        let p = plan("<http://x.example/u>", Some("List-Unsubscribe=One-Click"));
        assert_eq!(
            p,
            Some(UnsubscribePlan::Browser {
                url: "http://x.example/u".into()
            })
        );
    }

    #[test]
    fn mailto_parses_subject_and_body() {
        let p = plan(
            "<mailto:leave@list.example?subject=unsub%20me&body=please+go>",
            None,
        );
        assert_eq!(
            p,
            Some(UnsubscribePlan::Mailto {
                to: "leave@list.example".into(),
                subject: "unsub me".into(),
                body: "please go".into(),
            })
        );
    }

    #[test]
    fn mailto_defaults() {
        let p = plan("<mailto:leave@list.example>", None);
        assert_eq!(
            p,
            Some(UnsubscribePlan::Mailto {
                to: "leave@list.example".into(),
                subject: "unsubscribe".into(),
                body: "unsubscribe".into(),
            })
        );
    }

    #[test]
    fn browser_fallback_and_empty() {
        assert_eq!(
            plan("<https://x.example/u>", None),
            Some(UnsubscribePlan::Browser {
                url: "https://x.example/u".into()
            })
        );
        assert_eq!(plan("nothing useful", None), None);
        // Bare (unbracketed) value from a sloppy sender still parses.
        assert!(matches!(
            plan("https://x.example/u", Some("List-Unsubscribe=One-Click")),
            Some(UnsubscribePlan::OneClick { .. })
        ));
    }

    #[test]
    fn percent_decode_edge_cases() {
        assert_eq!(percent_decode("a%2Bb+c"), "a+b c");
        assert_eq!(percent_decode("bad%2"), "bad%2");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
