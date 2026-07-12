//! MIME parsing (mail-parser), HTML sanitization (ammonia), and outgoing
//! message construction (mail-builder).

use crate::error::{CoreError, Result};
use crate::models::Address;
use mail_parser::MimeHeaders;
use once_cell::sync::Lazy;

#[derive(Debug, Clone, Default)]
pub struct ParsedHeaders {
    pub message_id: Option<String>,
    pub subject: String,
    pub from: Option<Address>,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub date_ms: Option<i64>,
    pub references: Vec<String>,
    pub is_automated: bool,
    /// Raw List-Unsubscribe header value, e.g. "<https://…>, <mailto:…>".
    pub list_unsubscribe: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ParsedAttachment {
    pub part_id: String,
    pub filename: Option<String>,
    pub mime_type: Option<String>,
    pub size: i64,
    pub content_id: Option<String>,
    pub is_inline: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedBody {
    pub headers: ParsedHeaders,
    pub text: Option<String>,
    /// Sanitized HTML, safe for a sandboxed iframe.
    pub html: Option<String>,
    pub snippet: String,
    pub attachments: Vec<ParsedAttachment>,
    /// Raw text of any text/calendar parts (meeting invites).
    pub calendar_parts: Vec<String>,
}

fn addr_from(a: &mail_parser::Addr) -> Option<Address> {
    a.address().map(|e| Address {
        name: a.name().map(|n| n.to_string()),
        email: e.to_string(),
    })
}

fn collect_addrs(value: Option<&mail_parser::Address>) -> Vec<Address> {
    let mut out = Vec::new();
    if let Some(addr) = value {
        match addr {
            mail_parser::Address::List(list) => {
                out.extend(list.iter().filter_map(addr_from));
            }
            mail_parser::Address::Group(groups) => {
                for g in groups {
                    out.extend(g.addresses.iter().filter_map(addr_from));
                }
            }
        }
    }
    out
}

static SANITIZER: Lazy<ammonia::Builder<'static>> = Lazy::new(|| {
    let mut b = ammonia::Builder::default();
    b.add_generic_attributes([
        "style",
        "align",
        "valign",
        "width",
        "height",
        "border",
        "cellpadding",
        "cellspacing",
        "bgcolor",
        "color",
    ])
    .add_tags([
        "table", "thead", "tbody", "tfoot", "tr", "td", "th", "center", "font", "img",
    ])
    .add_tag_attributes("img", ["src", "alt", "width", "height"])
    .add_tag_attributes("font", ["face", "size", "color"])
    .add_tag_attributes("a", ["href", "title"])
    .url_schemes(std::collections::HashSet::from([
        "http", "https", "mailto", "cid", "data",
    ]))
    .link_rel(Some("noopener noreferrer"));
    b
});

pub fn sanitize_html(html: &str) -> String {
    SANITIZER.clean(html).to_string()
}

pub fn make_snippet(text: &str) -> String {
    let s: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    s.chars().take(140).collect()
}

fn parse_headers(msg: &mail_parser::Message) -> ParsedHeaders {
    let mut refs: Vec<String> = Vec::new();
    if let Some(irt) = msg.in_reply_to().as_text_list() {
        refs.extend(irt.iter().map(|s| s.to_string()));
    }
    if let Some(r) = msg.references().as_text_list() {
        for s in r {
            let s = s.to_string();
            if !refs.contains(&s) {
                refs.push(s);
            }
        }
    }

    let is_automated = msg.header("List-Id").is_some()
        || msg.header("List-Unsubscribe").is_some()
        || msg
            .header("Precedence")
            .and_then(|h| h.as_text())
            .map(|v| {
                let v = v.to_ascii_lowercase();
                v == "bulk" || v == "list" || v == "junk"
            })
            .unwrap_or(false)
        || msg.header("Auto-Submitted").is_some()
        || msg.header("X-Autoreply").is_some();

    ParsedHeaders {
        message_id: msg.message_id().map(|s| s.to_string()),
        subject: msg.subject().unwrap_or_default().to_string(),
        from: msg.from().and_then(|f| f.first()).and_then(addr_from),
        to: collect_addrs(msg.to()),
        cc: collect_addrs(msg.cc()),
        bcc: collect_addrs(msg.bcc()),
        date_ms: msg.date().map(|d| d.to_timestamp() * 1000),
        references: refs,
        is_automated,
        list_unsubscribe: msg
            .header("List-Unsubscribe")
            .and_then(|h| h.as_text())
            .map(|s| s.to_string()),
    }
}

/// Parse a full raw RFC 5322 message.
pub fn parse_message(raw: &[u8]) -> Result<ParsedBody> {
    let msg = mail_parser::MessageParser::default()
        .parse(raw)
        .ok_or_else(|| CoreError::Mime("unparseable message".into()))?;

    let headers = parse_headers(&msg);

    let text = msg.body_text(0).map(|t| t.to_string());
    let html = msg.body_html(0).map(|h| sanitize_html(&h));

    let snippet = text
        .as_deref()
        .map(make_snippet)
        .or_else(|| {
            html.as_deref()
                .map(|h| make_snippet(&ammonia::clean_text(h)))
        })
        .unwrap_or_default();

    let mut attachments = Vec::new();
    let mut calendar_parts = Vec::new();
    for (i, part) in msg.attachments().enumerate() {
        let filename = part.attachment_name().map(|s| s.to_string());
        let mime_type = part.content_type().map(|ct| match ct.subtype() {
            Some(sub) => format!("{}/{}", ct.ctype(), sub),
            None => ct.ctype().to_string(),
        });
        if mime_type
            .as_deref()
            .is_some_and(|m| m.eq_ignore_ascii_case("text/calendar"))
        {
            calendar_parts.push(String::from_utf8_lossy(part.contents()).into_owned());
        }
        let content_id = part.content_id().map(|s| s.to_string());
        attachments.push(ParsedAttachment {
            part_id: i.to_string(),
            filename,
            mime_type,
            size: part.contents().len() as i64,
            is_inline: content_id.is_some(),
            content_id,
        });
    }
    // Invites are often an *alternative* body part rather than an attachment.
    for part in msg.text_bodies() {
        let is_cal = part.content_type().is_some_and(|ct| {
            ct.subtype()
                .is_some_and(|s| s.eq_ignore_ascii_case("calendar"))
        });
        if is_cal {
            calendar_parts.push(String::from_utf8_lossy(part.contents()).into_owned());
        }
    }

    Ok(ParsedBody {
        headers,
        text,
        html,
        snippet,
        attachments,
        calendar_parts,
    })
}

/// Parse only headers (from a HEADER.FIELDS fetch).
pub fn parse_header_block(raw: &[u8]) -> Result<ParsedHeaders> {
    let msg = mail_parser::MessageParser::default()
        .parse_headers(raw)
        .ok_or_else(|| CoreError::Mime("unparseable headers".into()))?;
    Ok(parse_headers(&msg))
}

/// Extract one attachment's bytes from a raw message by attachment index.
pub fn extract_attachment(raw: &[u8], part_id: &str) -> Result<(Vec<u8>, Option<String>)> {
    let msg = mail_parser::MessageParser::default()
        .parse(raw)
        .ok_or_else(|| CoreError::Mime("unparseable message".into()))?;
    let idx: usize = part_id
        .parse()
        .map_err(|_| CoreError::Mime("bad part id".into()))?;
    let part = msg
        .attachments()
        .nth(idx)
        .ok_or_else(|| CoreError::NotFound("attachment".into()))?;
    Ok((
        part.contents().to_vec(),
        part.attachment_name().map(|s| s.to_string()),
    ))
}

pub struct OutgoingAttachment {
    pub filename: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

pub struct OutgoingMessage<'a> {
    pub from: Address,
    pub to: &'a [Address],
    pub cc: &'a [Address],
    pub bcc: &'a [Address],
    pub subject: &'a str,
    pub body_text: &'a str,
    /// Message-ID of the message being replied to.
    pub in_reply_to: Option<&'a str>,
    /// Full reference chain (oldest first), including in_reply_to last.
    pub references: &'a [String],
    pub message_id_domain: &'a str,
    pub attachments: Vec<OutgoingAttachment>,
}

/// Build a raw RFC 5322 message. Returns (message_id, raw_bytes).
pub fn build_message(out: &OutgoingMessage) -> Result<(String, Vec<u8>)> {
    let msg_id = format!(
        "<{}.{}@{}>",
        chrono::Utc::now().timestamp_micros(),
        rand_token(),
        out.message_id_domain
    );

    let to_mb: Vec<(String, String)> = out
        .to
        .iter()
        .map(|a| (a.name.clone().unwrap_or_default(), a.email.clone()))
        .collect();
    let cc_mb: Vec<(String, String)> = out
        .cc
        .iter()
        .map(|a| (a.name.clone().unwrap_or_default(), a.email.clone()))
        .collect();
    let bcc_mb: Vec<(String, String)> = out
        .bcc
        .iter()
        .map(|a| (a.name.clone().unwrap_or_default(), a.email.clone()))
        .collect();

    let mut builder = mail_builder::MessageBuilder::new()
        .message_id(msg_id.trim_matches(['<', '>']).to_string())
        .from((
            out.from.name.clone().unwrap_or_default(),
            out.from.email.clone(),
        ))
        .subject(out.subject)
        .text_body(out.body_text);

    if !to_mb.is_empty() {
        builder = builder.to(to_mb);
    }
    if !cc_mb.is_empty() {
        builder = builder.cc(cc_mb);
    }
    if !bcc_mb.is_empty() {
        builder = builder.bcc(bcc_mb);
    }
    for att in &out.attachments {
        builder = builder.attachment(
            att.mime_type.clone(),
            att.filename.clone(),
            att.bytes.clone(),
        );
    }
    if let Some(irt) = out.in_reply_to {
        builder = builder.in_reply_to(irt.trim_matches(['<', '>']).to_string());
    }
    if !out.references.is_empty() {
        let refs: Vec<String> = out
            .references
            .iter()
            .map(|r| r.trim_matches(['<', '>']).to_string())
            .collect();
        builder = builder.references(refs);
    }

    let raw = builder
        .write_to_vec()
        .map_err(|e| CoreError::Mime(e.to_string()))?;
    Ok((msg_id, raw))
}

pub(crate) fn rand_token() -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    (0..10)
        .map(|_| {
            let c: u8 = rng.random_range(0..36);
            if c < 10 {
                (b'0' + c) as char
            } else {
                (b'a' + c - 10) as char
            }
        })
        .collect()
}

/// Quote a message body for reply/forward.
pub fn quote_body(original_text: &str, from: &Address, date_ms: i64) -> String {
    let when = chrono::DateTime::from_timestamp_millis(date_ms)
        .map(|d| d.format("%a, %b %-d, %Y at %-I:%M %p").to_string())
        .unwrap_or_default();
    let who = from.name.clone().unwrap_or_else(|| from.email.clone());
    let quoted: String = original_text.lines().map(|l| format!("> {l}\n")).collect();
    format!("\n\nOn {when}, {who} <{}> wrote:\n{quoted}", from.email)
}

/// Strip Re:/Fwd: prefixes and normalize whitespace/case for subject threading.
pub fn normalize_subject(subject: &str) -> String {
    static PREFIX: Lazy<regex::Regex> = Lazy::new(|| {
        regex::Regex::new(r"(?i)^\s*((re|fwd?|fw|aw|sv)\s*(\[\d+\])?\s*:\s*)+").unwrap()
    });
    static BRACKETS: Lazy<regex::Regex> =
        Lazy::new(|| regex::Regex::new(r"^\s*\[[^\]]{1,60}\]\s*").unwrap());
    let s = PREFIX.replace(subject, "");
    let s = BRACKETS.replace(&s, "");
    s.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_subjects() {
        assert_eq!(normalize_subject("Re: Re: Hello World"), "hello world");
        assert_eq!(normalize_subject("Fwd: [team] Standup"), "standup");
        assert_eq!(normalize_subject("FW: RE: x"), "x");
    }

    #[test]
    fn parses_simple_message() {
        let raw = b"Message-ID: <abc@example.com>\r\nFrom: Alice <alice@example.com>\r\nTo: Bob <bob@example.com>\r\nSubject: Hi\r\nDate: Mon, 1 Jan 2024 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nHello Bob!\r\n";
        let parsed = parse_message(raw).unwrap();
        assert_eq!(parsed.headers.subject, "Hi");
        assert_eq!(
            parsed.headers.from.as_ref().unwrap().email,
            "alice@example.com"
        );
        assert!(parsed.text.unwrap().contains("Hello Bob"));
    }
}
