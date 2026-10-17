//! Sender pictures for the avatar inbox UI.
//!
//! Each sender is resolved once, then served from an on-disk cache:
//!   1. Gravatar for the exact address (a person's own photo),
//!   2. BIMI: the brand logo a company publishes in DNS
//!      (`default._bimi.<domain>` TXT, `l=` points at an SVG; Apple, Amazon,
//!      PayPal, ...), tried on the sender's domain and then its parent domain,
//!   3. the site's own icon (`apple-touch-icon.png`, then `favicon.ico`).
//!
//! Logo steps are skipped for webmail domains so `bob@gmail.com` never shows
//! Google's logo. Misses are cached too, so a sender costs network at most
//! once per [`CACHE_TTL`].

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use base64::Engine;
use sha2::Digest;

/// How long a resolved picture (or a miss) is trusted before re-checking.
const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 3600);
/// Largest image accepted from any source.
const MAX_BYTES: usize = 512 * 1024;
/// Parallel lookups. The list asks for every visible row at once; this keeps
/// the burst polite and lets later callers hit the cache the first one wrote.
const MAX_CONCURRENT: usize = 4;

/// Personal-mail providers: their domain logo says nothing about the sender.
const WEBMAIL_DOMAINS: &[&str] = &[
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "yahoo.com",
    "ymail.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
    "pm.me",
    "gmx.com",
    "gmx.de",
    "gmx.net",
    "web.de",
    "mail.com",
    "yandex.ru",
    "yandex.com",
    "zoho.com",
    "fastmail.com",
    "hey.com",
    "qq.com",
    "163.com",
    "126.com",
    "naver.com",
    "tutanota.com",
    "duck.com",
];

fn semaphore() -> &'static tokio::sync::Semaphore {
    static SEM: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    SEM.get_or_init(|| tokio::sync::Semaphore::new(MAX_CONCURRENT))
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::limited(3))
            .user_agent(concat!("comail/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}

/// A resolved picture, ready for an `<img src>`.
fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Picture for `email` as a data URL, or None when no source has one.
pub async fn resolve(data_dir: &Path, email: &str) -> Option<String> {
    let email = email.trim().to_ascii_lowercase();
    let domain = email.rsplit_once('@')?.1.to_string();
    if domain.is_empty() || !domain.contains('.') {
        return None;
    }
    let dir = data_dir.join("avatars");
    let hash = hex(&sha2::Sha256::digest(email.as_bytes()));

    let person_key = dir.join(format!("p-{hash}"));
    let domain_key = dir.join(format!("d-{domain}"));
    let use_logo = !WEBMAIL_DOMAINS.contains(&domain.as_str());

    // Fast path: everything needed is already cached.
    match cached(&person_key) {
        Some(Some(photo)) => return Some(photo),
        Some(None) if !use_logo => return None,
        Some(None) => {
            if let Some(logo) = cached(&domain_key) {
                return logo;
            }
        }
        None => {}
    }

    let _permit = semaphore().acquire().await.ok()?;

    // Re-read after waiting: another lookup may have filled the cache.
    let photo = match cached(&person_key) {
        Some(hit) => hit,
        None => {
            let found = gravatar(&hash).await;
            store(&person_key, found.as_deref());
            found
        }
    };
    if photo.is_some() || !use_logo {
        return photo;
    }
    match cached(&domain_key) {
        Some(hit) => hit,
        None => {
            let logo = domain_logo(&domain).await;
            store(&domain_key, logo.as_deref());
            logo
        }
    }
}

/// BIMI logo, then the site's icon, for a sender domain.
async fn domain_logo(domain: &str) -> Option<String> {
    let parent = org_domain(domain);
    let mut candidates = vec![domain.to_string()];
    if parent != domain {
        candidates.push(parent.clone());
    }
    for d in &candidates {
        if let Some(url) = bimi(d).await {
            return Some(url);
        }
    }
    for d in &candidates {
        for path in ["apple-touch-icon.png", "favicon.ico"] {
            if let Some(url) = fetch_image(&format!("https://{d}/{path}")).await {
                return Some(url);
            }
        }
    }
    None
}

async fn gravatar(hash: &str) -> Option<String> {
    fetch_image(&format!("https://gravatar.com/avatar/{hash}?s=96&d=404")).await
}

async fn bimi(domain: &str) -> Option<String> {
    let resolver = hickory_resolver::TokioResolver::builder_tokio()
        .ok()?
        .build()
        .ok()?;
    let txt = resolver
        .txt_lookup(format!("default._bimi.{domain}."))
        .await
        .ok()?;
    let record: String = txt
        .answers()
        .iter()
        .filter_map(|r| match &r.data {
            hickory_resolver::proto::rr::RData::TXT(t) => Some(t),
            _ => None,
        })
        .map(|r| {
            r.txt_data
                .iter()
                .map(|part| String::from_utf8_lossy(part).into_owned())
                .collect::<String>()
        })
        .find(|s| s.trim_start().starts_with("v=BIMI1"))?;
    let logo = bimi_logo_url(&record)?;
    fetch_image(&logo).await
}

/// The `l=` logo URL from a BIMI record, https only.
fn bimi_logo_url(record: &str) -> Option<String> {
    record
        .split(';')
        .filter_map(|tag| tag.trim().split_once('='))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("l"))
        .map(|(_, v)| v.trim().to_string())
        .filter(|v| v.starts_with("https://"))
}

/// GET an image; None unless it is a real, reasonably sized image.
async fn fetch_image(url: &str) -> Option<String> {
    let resp = http().get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .unwrap_or_default();
    if resp
        .content_length()
        .is_some_and(|n| n as usize > MAX_BYTES)
    {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.len() < 64 || bytes.len() > MAX_BYTES {
        return None;
    }
    let mime = sniff_mime(&mime, &bytes)?;
    Some(data_url(mime, &bytes))
}

/// Trust the declared type only when it is an image; favicons are often
/// served as `application/octet-stream`, so fall back to magic bytes.
fn sniff_mime(declared: &str, bytes: &[u8]) -> Option<&'static str> {
    let by_magic = if bytes.starts_with(b"\x89PNG") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else {
        None
    };
    if by_magic.is_some() {
        return by_magic;
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_ascii_lowercase();
    if declared == "image/svg+xml" || head.contains("<svg") {
        return Some("image/svg+xml");
    }
    None
}

/// Registrable parent of a host: `email.apple.com` -> `apple.com`,
/// `news.bbc.co.uk` -> `bbc.co.uk`. A small heuristic, not the full PSL:
/// two-letter country TLDs with a generic second level keep three labels.
fn org_domain(domain: &str) -> String {
    let labels: Vec<&str> = domain.split('.').filter(|l| !l.is_empty()).collect();
    if labels.len() <= 2 {
        return labels.join(".");
    }
    let n = labels.len();
    let generic_sld = ["co", "com", "net", "org", "ac", "gov", "edu", "ne", "or"];
    let keep = if labels[n - 1].len() == 2 && generic_sld.contains(&labels[n - 2]) {
        3
    } else {
        2
    };
    labels[n - keep..].join(".")
}

/// Cache file contents: `Some(Some(url))` hit, `Some(None)` cached miss,
/// `None` absent or expired.
fn cached(path: &PathBuf) -> Option<Option<String>> {
    let meta = std::fs::metadata(path).ok()?;
    let age = meta
        .modified()
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok())?;
    if age > CACHE_TTL {
        return None;
    }
    let body = std::fs::read_to_string(path).ok()?;
    Some((!body.is_empty()).then_some(body))
}

fn store(path: &Path, value: Option<&str>) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Write-then-rename so a concurrent reader never sees half a data URL.
    let tmp = path.with_extension("part");
    if std::fs::write(&tmp, value.unwrap_or("")).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn org_domain_strips_subdomains() {
        assert_eq!(org_domain("email.apple.com"), "apple.com");
        assert_eq!(org_domain("apple.com"), "apple.com");
        assert_eq!(org_domain("news.bbc.co.uk"), "bbc.co.uk");
        assert_eq!(org_domain("a.b.example.io"), "example.io");
    }

    #[test]
    fn bimi_record_logo() {
        assert_eq!(
            bimi_logo_url("v=BIMI1;l=https://www.apple.com/bimi/v2/apple.svg;a=https://x/a.pem;")
                .as_deref(),
            Some("https://www.apple.com/bimi/v2/apple.svg")
        );
        assert_eq!(bimi_logo_url("v=BIMI1; l=; a=;"), None);
        assert_eq!(bimi_logo_url("v=BIMI1; l=http://insecure/logo.svg"), None);
    }

    #[test]
    fn sniff_rejects_html_and_accepts_images() {
        assert_eq!(sniff_mime("text/html", b"<!doctype html><html>"), None);
        assert_eq!(
            sniff_mime("application/octet-stream", b"\x89PNG\r\n"),
            Some("image/png")
        );
        assert_eq!(
            sniff_mime("image/svg+xml", b"<?xml?><svg/>"),
            Some("image/svg+xml")
        );
        assert_eq!(sniff_mime("", &[0, 0, 1, 0, 1]), Some("image/x-icon"));
    }

    /// Network smoke test: `cargo test -p comail-core --lib live_resolve -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_resolve() {
        let dir = std::env::temp_dir().join(format!("comail-avatars-live-{}", std::process::id()));
        for email in [
            "no_reply@email.apple.com",
            "auto-confirm@amazon.com",
            "notifications@github.com",
            "someone.random.xyz123@gmail.com",
        ] {
            let got = resolve(&dir, email).await;
            println!(
                "{email:40} -> {}",
                got.as_deref()
                    .map(|u| &u[..u.len().min(40)])
                    .unwrap_or("none")
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cache_round_trip_hit_and_miss() {
        let dir = std::env::temp_dir().join(format!("comail-avatars-{}", std::process::id()));
        let hit = dir.join("p-hit");
        let miss = dir.join("p-miss");
        store(&hit, Some("data:image/png;base64,AA"));
        store(&miss, None);
        assert_eq!(cached(&hit), Some(Some("data:image/png;base64,AA".into())));
        assert_eq!(cached(&miss), Some(None));
        assert_eq!(cached(&dir.join("absent")), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
