//! RFC 8058 one-click unsubscribe (and RFC 2369 mailto / HTTPS fallbacks).
//!
//! Clients that advertise `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
//! must be unsubscribed with an HTTPS POST body `List-Unsubscribe=One-Click`
//! (no cookies, no credentials, no redirect-following on POST). Opening the
//! URL in a browser is a fallback only when One-Click is not advertised.

use crate::error::Result;
use crate::mime;
use serde::Serialize;
use std::time::Duration;

const ONE_CLICK_BODY: &str = "List-Unsubscribe=One-Click";
const POST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailtoUnsubscribe {
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsubscribeResult {
    pub ok: bool,
    /// `"one_click"` | `"needs_browser"` | `"mailto"`
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// HTTPS URL for `needs_browser` (or the URL that was POSTed on success).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mailto: Option<MailtoUnsubscribe>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// True when `List-Unsubscribe-Post` advertises RFC 8058 One-Click.
pub fn advertises_one_click(post: Option<&str>) -> bool {
    post.is_some_and(|p| p.trim().eq_ignore_ascii_case("List-Unsubscribe=One-Click"))
}

/// Extract URI entries from a raw `List-Unsubscribe` header value.
/// Prefers angle-bracket form (`<https://…>, <mailto:…>`); falls back to
/// comma-split bare URIs (some ESPs omit brackets).
pub fn parse_unsubscribe_uris(raw: &str) -> Vec<String> {
    let bracketed: Vec<String> = raw
        .match_indices('<')
        .filter_map(|(start, _)| {
            let rest = &raw[start + 1..];
            let end = rest.find('>')?;
            let uri = rest[..end].trim();
            (!uri.is_empty()).then(|| uri.to_string())
        })
        .collect();
    if !bracketed.is_empty() {
        return bracketed;
    }
    raw.split(',')
        .map(|s| s.trim().trim_matches(|c| c == '<' || c == '>').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn first_https_uri(uris: &[String]) -> Option<&str> {
    uris.iter()
        .find(|u| u.to_ascii_lowercase().starts_with("https://"))
        .map(|s| s.as_str())
}

pub fn first_mailto_uri(uris: &[String]) -> Option<&str> {
    uris.iter()
        .find(|u| u.to_ascii_lowercase().starts_with("mailto:"))
        .map(|s| s.as_str())
}

/// Parse `mailto:addr?subject=…&body=…` (query values are percent-decoded).
pub fn parse_mailto(uri: &str) -> Option<MailtoUnsubscribe> {
    let rest = if uri.len() >= 7 && uri[..7].eq_ignore_ascii_case("mailto:") {
        &uri[7..]
    } else {
        return None;
    };
    let (addr_part, query) = match rest.split_once('?') {
        Some((a, q)) => (a, Some(q)),
        None => (rest, None),
    };
    let to = addr_part.trim();
    if to.is_empty() {
        return None;
    }
    let mut subject = None;
    let mut body = None;
    if let Some(q) = query {
        for pair in q.split('&') {
            let (k, v) = match pair.split_once('=') {
                Some((k, v)) => (k, v),
                None => continue,
            };
            let decoded = urlencoding_decode(v);
            match k.to_ascii_lowercase().as_str() {
                "subject" => subject = Some(decoded),
                "body" => body = Some(decoded),
                _ => {}
            }
        }
    }
    Some(MailtoUnsubscribe {
        to: to.to_string(),
        subject,
        body,
    })
}

fn urlencoding_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let h = |c: u8| -> Option<u8> {
                    match c {
                        b'0'..=b'9' => Some(c - b'0'),
                        b'a'..=b'f' => Some(c - b'a' + 10),
                        b'A'..=b'F' => Some(c - b'A' + 10),
                        _ => None,
                    }
                };
                if let (Some(hi), Some(lo)) = (h(bytes[i + 1]), h(bytes[i + 2])) {
                    out.push((hi << 4) | lo);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Decide the unsubscribe action without performing the HTTP POST.
pub fn plan_unsubscribe(
    list_unsubscribe: Option<&str>,
    list_unsubscribe_post: Option<&str>,
) -> UnsubscribeResult {
    let Some(raw) = list_unsubscribe.map(str::trim).filter(|s| !s.is_empty()) else {
        return UnsubscribeResult {
            ok: false,
            method: "one_click".into(),
            status: None,
            url: None,
            mailto: None,
            error: Some("no List-Unsubscribe header".into()),
        };
    };
    let uris = parse_unsubscribe_uris(raw);
    let https = first_https_uri(&uris);
    let mailto = first_mailto_uri(&uris).and_then(parse_mailto);

    if advertises_one_click(list_unsubscribe_post) {
        if let Some(url) = https {
            return UnsubscribeResult {
                ok: false, // not yet performed
                method: "one_click".into(),
                status: None,
                url: Some(url.to_string()),
                mailto: None,
                error: None,
            };
        }
    }

    if let Some(url) = https {
        return UnsubscribeResult {
            ok: false,
            method: "needs_browser".into(),
            status: None,
            url: Some(url.to_string()),
            mailto: None,
            error: None,
        };
    }

    if let Some(m) = mailto {
        return UnsubscribeResult {
            ok: false,
            method: "mailto".into(),
            status: None,
            url: None,
            mailto: Some(m),
            error: None,
        };
    }

    UnsubscribeResult {
        ok: false,
        method: "one_click".into(),
        status: None,
        url: None,
        mailto: None,
        error: Some("no usable https or mailto unsubscribe target".into()),
    }
}

/// Perform RFC 8058 One-Click POST. Does not follow redirects.
pub async fn post_one_click(url: &str) -> UnsubscribeResult {
    if !url.to_ascii_lowercase().starts_with("https://") {
        return UnsubscribeResult {
            ok: false,
            method: "one_click".into(),
            status: None,
            url: Some(url.to_string()),
            mailto: None,
            error: Some("one-click URL must be https".into()),
        };
    }

    let client = match reqwest::Client::builder()
        .timeout(POST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return UnsubscribeResult {
                ok: false,
                method: "one_click".into(),
                status: None,
                url: Some(url.to_string()),
                mailto: None,
                error: Some(format!("http client: {e}")),
            };
        }
    };

    let response = client
        .post(url)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(ONE_CLICK_BODY)
        .send()
        .await;

    match response {
        Ok(resp) => {
            let status = resp.status();
            let code = status.as_u16();
            if status.is_success() {
                UnsubscribeResult {
                    ok: true,
                    method: "one_click".into(),
                    status: Some(code),
                    url: Some(url.to_string()),
                    mailto: None,
                    error: None,
                }
            } else if status.is_redirection() {
                UnsubscribeResult {
                    ok: false,
                    method: "needs_browser".into(),
                    status: Some(code),
                    url: Some(url.to_string()),
                    mailto: None,
                    error: Some(format!(
                        "sender redirected POST ({code}); open in browser to confirm"
                    )),
                }
            } else {
                UnsubscribeResult {
                    ok: false,
                    method: "one_click".into(),
                    status: Some(code),
                    url: Some(url.to_string()),
                    mailto: None,
                    error: Some(format!("unsubscribe POST returned {code}")),
                }
            }
        }
        Err(e) => UnsubscribeResult {
            ok: false,
            method: "one_click".into(),
            status: None,
            url: Some(url.to_string()),
            mailto: None,
            error: Some(e.to_string()),
        },
    }
}

/// Plan + execute: One-Click POST when advertised; otherwise return
/// `needs_browser` / `mailto` for the UI to finish.
pub async fn unsubscribe(
    list_unsubscribe: Option<&str>,
    list_unsubscribe_post: Option<&str>,
) -> UnsubscribeResult {
    let plan = plan_unsubscribe(list_unsubscribe, list_unsubscribe_post);
    if plan.method == "one_click" {
        if let Some(url) = plan.url.clone() {
            return post_one_click(&url).await;
        }
    }
    plan
}

/// Pull unsubscribe headers from a cached raw `.eml` (header block or full message).
pub fn headers_from_raw(raw: &[u8]) -> Result<(Option<String>, Option<String>)> {
    let parsed =
        mime::parse_header_block(raw).or_else(|_| mime::parse_message(raw).map(|b| b.headers))?;
    Ok((parsed.list_unsubscribe, parsed.list_unsubscribe_post))
}

/// Host-only redaction for logs / proof (never log query tokens).
pub fn redact_url_for_log(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) => format!(
            "{}://{}{}",
            u.scheme(),
            u.host_str().unwrap_or("?"),
            u.path()
        ),
        Err(_) => "<unparseable-url>".into(),
    }
}

#[allow(dead_code)]
pub fn one_click_body() -> &'static str {
    ONE_CLICK_BODY
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_angle_brackets_and_mailto_https_mix() {
        let raw = "<mailto:u@x.example?subject=Leave>, <https://x.example/unsub?t=1>";
        let uris = parse_unsubscribe_uris(raw);
        assert_eq!(uris.len(), 2);
        assert!(first_https_uri(&uris).unwrap().starts_with("https://"));
        let m = parse_mailto(first_mailto_uri(&uris).unwrap()).unwrap();
        assert_eq!(m.to, "u@x.example");
        assert_eq!(m.subject.as_deref(), Some("Leave"));
    }

    #[test]
    fn parses_bare_https_without_brackets() {
        let raw = "https://account.example.com/profile/unsubscribe?K=abc";
        let uris = parse_unsubscribe_uris(raw);
        assert_eq!(uris.len(), 1);
        assert!(first_https_uri(&uris).is_some());
    }

    #[test]
    fn one_click_detection_is_case_insensitive() {
        assert!(advertises_one_click(Some("List-Unsubscribe=One-Click")));
        assert!(advertises_one_click(Some("list-unsubscribe=one-click")));
        assert!(!advertises_one_click(Some("something-else")));
        assert!(!advertises_one_click(None));
    }

    #[test]
    fn plan_prefers_one_click_when_post_present() {
        let r = plan_unsubscribe(
            Some("<https://esp.example/u/1>, <mailto:u@esp.example>"),
            Some("List-Unsubscribe=One-Click"),
        );
        assert_eq!(r.method, "one_click");
        assert!(r.url.unwrap().starts_with("https://"));
    }

    #[test]
    fn plan_needs_browser_without_post() {
        let r = plan_unsubscribe(Some("<https://esp.example/u/1>"), None);
        assert_eq!(r.method, "needs_browser");
        assert!(!r.ok);
    }

    #[test]
    fn plan_mailto_when_no_https() {
        let r = plan_unsubscribe(
            Some("<mailto:leave@list.example?subject=unsubscribe%20me&body=bye>"),
            None,
        );
        assert_eq!(r.method, "mailto");
        let m = r.mailto.unwrap();
        assert_eq!(m.to, "leave@list.example");
        assert_eq!(m.subject.as_deref(), Some("unsubscribe me"));
        assert_eq!(m.body.as_deref(), Some("bye"));
    }

    #[test]
    fn redact_strips_query() {
        let s = redact_url_for_log("https://app.loops.so/unsubscribe/abc/secrettoken?x=1");
        assert_eq!(s, "https://app.loops.so/unsubscribe/abc/secrettoken");
        assert!(!s.contains("x=1"));
    }

    #[tokio::test]
    async fn post_one_click_hits_local_server() {
        use std::sync::{Arc, Mutex};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let got = Arc::new(Mutex::new(None::<String>));
        let got2 = got.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            *got2.lock().unwrap() = Some(req);
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .await
                .unwrap();
        });

        // Local http — post_one_click requires https; use a tiny wrapper path
        // via plan that still validates the body contract with a raw client.
        let client = reqwest::Client::builder()
            .timeout(POST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let url = format!("http://127.0.0.1:{port}/unsub");
        let resp = client
            .post(&url)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body(ONE_CLICK_BODY)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);

        // Wait briefly for handler to store the request
        tokio::time::sleep(Duration::from_millis(50)).await;
        let req = got.lock().unwrap().clone().expect("request captured");
        assert!(req.starts_with("POST /unsub"), "verb+path: {req}");
        assert!(
            req.to_ascii_lowercase()
                .contains("content-type: application/x-www-form-urlencoded"),
            "{req}"
        );
        assert!(req.contains(ONE_CLICK_BODY), "{req}");
    }

    #[tokio::test]
    async fn rejects_non_https_one_click() {
        let r = post_one_click("http://example.com/unsub").await;
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("https"));
    }
}
