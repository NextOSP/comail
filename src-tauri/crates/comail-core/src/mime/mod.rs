//! MIME parsing (mail-parser), HTML sanitization (ammonia), and outgoing
//! message construction (mail-builder).

use crate::error::{CoreError, Result};
use crate::models::Address;
use mail_parser::MimeHeaders;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

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
    /// The party that actually transmitted the message, when its domain does
    /// NOT align with From: (mailing lists, ESPs, send-on-behalf — and mail
    /// whose From: is spoofed). First misaligned identity out of the RFC 5322
    /// Sender:, the receiver-stamped Return-Path, and the DKIM d= domain;
    /// None when everything aligns with From:.
    pub via: Option<String>,
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

/// Schema version written into `messages.mime_plan_json`.
pub const MIME_PLAN_VERSION: u8 = 1;

/// A compact, serializable description of the IMAP sections needed to make a
/// message readable without downloading unrelated attachment bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MimePlan {
    pub version: u8,
    #[serde(default)]
    pub text_sections: Vec<PlannedTextSection>,
    #[serde(default)]
    pub attachments: Vec<PlannedAttachment>,
}

impl Default for MimePlan {
    fn default() -> Self {
        Self {
            version: MIME_PLAN_VERSION,
            text_sections: Vec::new(),
            attachments: Vec::new(),
        }
    }
}

impl MimePlan {
    /// IMAP section identifiers safe to pass to [`crate::imap::fetch_content_sections`].
    pub fn text_section_ids(&self) -> Vec<String> {
        self.text_sections
            .iter()
            .map(|part| part.section.clone())
            .collect()
    }

    /// The paperclip signal deliberately excludes embedded CID images.
    pub fn has_file_attachments(&self) -> bool {
        self.attachments.iter().any(|part| !part.is_inline)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextSectionKind {
    Plain,
    Html,
    Calendar,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannedTextSection {
    /// Numeric IMAP BODY section, for example `1` or `2.1`.
    pub section: String,
    pub kind: TextSectionKind,
    pub mime_type: String,
    pub charset: Option<String>,
    pub transfer_encoding: String,
    /// Encoded octet count reported by BODYSTRUCTURE.
    pub size: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannedAttachment {
    /// Numeric IMAP BODY section, for example `2` or `3.1`.
    pub section: String,
    pub filename: Option<String>,
    pub mime_type: String,
    pub size: u32,
    pub content_id: Option<String>,
    pub is_inline: bool,
    pub transfer_encoding: String,
}

/// Build the selective-fetch plan directly from an IMAP BODYSTRUCTURE tree.
/// Only readable body parts (plain text, HTML, and calendars) enter
/// `text_sections`; PDFs, images, and other files are descriptors only.
pub fn plan_bodystructure(bs: &async_imap::imap_proto::BodyStructure<'_>) -> MimePlan {
    use async_imap::imap_proto::{BodyContentCommon, BodyContentSinglePart, BodyStructure};

    fn param(params: &async_imap::imap_proto::BodyParams<'_>, key: &str) -> Option<String> {
        params.as_ref().and_then(|items| {
            items
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(key))
                .map(|(_, value)| value.to_string())
        })
    }

    fn encoding(value: &async_imap::imap_proto::ContentEncoding<'_>) -> String {
        use async_imap::imap_proto::ContentEncoding;
        match value {
            ContentEncoding::SevenBit => "7bit".into(),
            ContentEncoding::EightBit => "8bit".into(),
            ContentEncoding::Binary => "binary".into(),
            ContentEncoding::Base64 => "base64".into(),
            ContentEncoding::QuotedPrintable => "quoted-printable".into(),
            ContentEncoding::Other(value) => value.to_ascii_lowercase(),
        }
    }

    fn section(path: &[u32]) -> String {
        if path.is_empty() {
            "1".into()
        } else {
            path.iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(".")
        }
    }

    fn add_single(
        common: &BodyContentCommon<'_>,
        other: &BodyContentSinglePart<'_>,
        path: &[u32],
        plan: &mut MimePlan,
    ) {
        let section = section(path);
        let mime_type = format!("{}/{}", common.ty.ty, common.ty.subtype).to_ascii_lowercase();
        let filename = common
            .disposition
            .as_ref()
            .and_then(|value| param(&value.params, "filename"))
            .or_else(|| param(&common.ty.params, "name"));
        let disposition = common.disposition.as_ref().map(|value| value.ty.as_ref());
        let explicit_attachment = disposition
            .is_some_and(|value| value.eq_ignore_ascii_case("attachment"))
            || filename.is_some();
        let content_id = other.id.as_ref().map(|value| normalize_cid(value));
        let is_inline = disposition.is_some_and(|value| value.eq_ignore_ascii_case("inline"))
            || content_id.is_some();

        let kind = if mime_type == "text/plain" {
            Some(TextSectionKind::Plain)
        } else if mime_type == "text/html" {
            Some(TextSectionKind::Html)
        } else if mime_type == "text/calendar" {
            Some(TextSectionKind::Calendar)
        } else {
            None
        };

        // A named text file is an attachment, not the message body. Calendar
        // files are the exception: they are fetched for event extraction and
        // also remain visible as an attachment.
        if let Some(kind) =
            kind.filter(|kind| !explicit_attachment || matches!(kind, TextSectionKind::Calendar))
        {
            plan.text_sections.push(PlannedTextSection {
                section: section.clone(),
                kind,
                mime_type: mime_type.clone(),
                charset: param(&common.ty.params, "charset"),
                transfer_encoding: encoding(&other.transfer_encoding),
                size: other.octets,
            });
        }

        let is_non_body_part = !mime_type.starts_with("text/") || explicit_attachment;
        if is_non_body_part || (mime_type == "text/calendar" && explicit_attachment) {
            plan.attachments.push(PlannedAttachment {
                section,
                filename,
                mime_type,
                size: other.octets,
                content_id,
                is_inline,
                transfer_encoding: encoding(&other.transfer_encoding),
            });
        }
    }

    fn walk(bs: &BodyStructure<'_>, path: &mut Vec<u32>, plan: &mut MimePlan) {
        match bs {
            BodyStructure::Multipart { bodies, .. } => {
                for (index, body) in bodies.iter().enumerate() {
                    path.push((index + 1) as u32);
                    walk(body, path, plan);
                    path.pop();
                }
            }
            BodyStructure::Basic { common, other, .. }
            | BodyStructure::Text { common, other, .. } => {
                add_single(common, other, path, plan);
            }
            BodyStructure::Message { common, other, .. } => {
                // message/rfc822 is normally a forwarded-message attachment.
                // Treat it atomically; recursing would require the special
                // RFC 3501 MESSAGE section-numbering rules and would bulk-fetch
                // content the user did not ask to open.
                add_single(common, other, path, plan);
            }
        }
    }

    let mut plan = MimePlan::default();
    walk(bs, &mut Vec::new(), &mut plan);
    plan
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedTextSection {
    pub kind: TextSectionKind,
    /// Plain/calendar text, or sanitized HTML for `Html`.
    pub content: String,
}

fn section_entity(mime_header: &[u8], encoded_body: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity(mime_header.len() + encoded_body.len() + 4);
    raw.extend_from_slice(mime_header);
    if !(mime_header.ends_with(b"\r\n\r\n") || mime_header.ends_with(b"\n\n")) {
        if mime_header.ends_with(b"\r\n") {
            raw.extend_from_slice(b"\r\n");
        } else if mime_header.ends_with(b"\n") {
            raw.extend_from_slice(b"\n");
        } else {
            raw.extend_from_slice(b"\r\n\r\n");
        }
    }
    raw.extend_from_slice(encoded_body);
    raw
}

/// Decode transfer encoding and charset for one fetched text MIME entity.
/// HTML is sanitized through the same allow-list as full-message parsing.
pub fn decode_text_section(
    kind: TextSectionKind,
    mime_header: &[u8],
    encoded_body: &[u8],
) -> Result<DecodedTextSection> {
    let raw = section_entity(mime_header, encoded_body);
    let msg = mail_parser::MessageParser::default()
        .parse(&raw)
        .ok_or_else(|| CoreError::Mime("unparseable MIME section".into()))?;
    let content = msg
        .root_part()
        .text_contents()
        .map(str::to_owned)
        .unwrap_or_else(|| String::from_utf8_lossy(msg.root_part().contents()).into_owned());
    Ok(DecodedTextSection {
        kind,
        content: if kind == TextSectionKind::Html {
            sanitize_html(&content)
        } else {
            content
        },
    })
}

/// Decode one on-demand attachment MIME entity without parsing or retaining a
/// complete RFC 5322 message.
pub fn decode_attachment_section(mime_header: &[u8], encoded_body: &[u8]) -> Result<Vec<u8>> {
    let raw = section_entity(mime_header, encoded_body);
    let msg = mail_parser::MessageParser::default()
        .parse(&raw)
        .ok_or_else(|| CoreError::Mime("unparseable attachment MIME section".into()))?;
    Ok(msg.root_part().contents().to_vec())
}

#[cfg(test)]
mod selective_section_tests {
    use super::*;
    use async_imap::imap_proto::{
        BodyContentCommon, BodyContentSinglePart, BodyStructure, ContentDisposition,
        ContentEncoding, ContentType,
    };
    use std::borrow::Cow;

    fn common(
        ty: &'static str,
        subtype: &'static str,
        params: &[(&'static str, &'static str)],
        disposition: Option<(&'static str, &'static str)>,
    ) -> BodyContentCommon<'static> {
        BodyContentCommon {
            ty: ContentType {
                ty: Cow::Borrowed(ty),
                subtype: Cow::Borrowed(subtype),
                params: (!params.is_empty()).then(|| {
                    params
                        .iter()
                        .map(|(key, value)| (Cow::Borrowed(*key), Cow::Borrowed(*value)))
                        .collect()
                }),
            },
            disposition: disposition.map(|(ty, filename)| ContentDisposition {
                ty: Cow::Borrowed(ty),
                params: Some(vec![(Cow::Borrowed("filename"), Cow::Borrowed(filename))]),
            }),
            language: None,
            location: None,
        }
    }

    fn other(
        id: Option<&'static str>,
        transfer_encoding: ContentEncoding<'static>,
        octets: u32,
    ) -> BodyContentSinglePart<'static> {
        BodyContentSinglePart {
            id: id.map(Cow::Borrowed),
            md5: None,
            description: None,
            transfer_encoding,
            octets,
        }
    }

    fn text(
        subtype: &'static str,
        params: &[(&'static str, &'static str)],
        disposition: Option<(&'static str, &'static str)>,
        encoding: ContentEncoding<'static>,
        octets: u32,
    ) -> BodyStructure<'static> {
        BodyStructure::Text {
            common: common("text", subtype, params, disposition),
            other: other(None, encoding, octets),
            lines: 1,
            extension: None,
        }
    }

    fn basic(
        ty: &'static str,
        subtype: &'static str,
        disposition: Option<(&'static str, &'static str)>,
        id: Option<&'static str>,
        octets: u32,
    ) -> BodyStructure<'static> {
        BodyStructure::Basic {
            common: common(ty, subtype, &[], disposition),
            other: other(id, ContentEncoding::Base64, octets),
            extension: None,
        }
    }

    #[test]
    fn bodystructure_plan_fetches_only_readable_sections() {
        let structure = BodyStructure::Multipart {
            common: common("multipart", "mixed", &[], None),
            bodies: vec![
                BodyStructure::Multipart {
                    common: common("multipart", "alternative", &[], None),
                    bodies: vec![
                        text(
                            "plain",
                            &[("charset", "iso-8859-1")],
                            None,
                            ContentEncoding::QuotedPrintable,
                            20,
                        ),
                        text("html", &[], None, ContentEncoding::Base64, 40),
                    ],
                    extension: None,
                },
                text(
                    "calendar",
                    &[("charset", "utf-8")],
                    Some(("attachment", "invite.ics")),
                    ContentEncoding::EightBit,
                    80,
                ),
                basic(
                    "image",
                    "png",
                    Some(("inline", "logo.png")),
                    Some("<logo@cid>"),
                    100,
                ),
                basic(
                    "application",
                    "pdf",
                    Some(("attachment", "report.pdf")),
                    None,
                    5_000,
                ),
            ],
            extension: None,
        };

        let plan = plan_bodystructure(&structure);
        assert_eq!(plan.version, MIME_PLAN_VERSION);
        assert_eq!(plan.text_section_ids(), vec!["1.1", "1.2", "2"]);
        assert_eq!(
            plan.text_sections
                .iter()
                .map(|part| part.kind)
                .collect::<Vec<_>>(),
            vec![
                TextSectionKind::Plain,
                TextSectionKind::Html,
                TextSectionKind::Calendar
            ]
        );
        assert_eq!(
            plan.attachments
                .iter()
                .map(|part| (part.section.as_str(), part.is_inline))
                .collect::<Vec<_>>(),
            vec![("2", false), ("3", true), ("4", false)]
        );
        assert_eq!(plan.attachments[1].content_id.as_deref(), Some("logo@cid"));
        assert!(plan.has_file_attachments());

        let json = serde_json::to_string(&plan).unwrap();
        assert_eq!(serde_json::from_str::<MimePlan>(&json).unwrap(), plan);
    }

    #[test]
    fn decodes_charset_and_sanitizes_html_sections() {
        let plain = decode_text_section(
            TextSectionKind::Plain,
            b"Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n",
            b"Ol=E1 mundo",
        )
        .unwrap();
        assert_eq!(plain.content, "Ol\u{e1} mundo");

        let html = decode_text_section(
            TextSectionKind::Html,
            b"Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n",
            b"<p onclick=\"steal()\">Hello</p><script>steal()</script>",
        )
        .unwrap();
        assert!(html.content.contains("<p>Hello</p>"));
        assert!(!html.content.contains("onclick"));
        assert!(!html.content.contains("<script"));
    }

    #[test]
    fn decodes_one_attachment_entity() {
        let bytes = decode_attachment_section(
            b"Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n",
            b"AAEC/w==",
        )
        .unwrap();
        assert_eq!(bytes, vec![0, 1, 2, 255]);
    }
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

/// `src="cid:<id>"` / `src='cid:<id>'` in a body (id in group 2 or 3).
static CID_SRC: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r#"(?i)src\s*=\s*(?:"cid:([^"]+)"|'cid:([^']+)')"#).unwrap());

/// Normalize a Content-ID / `cid:` reference for matching (drop `<>` + spaces).
pub fn normalize_cid(id: &str) -> String {
    id.trim().trim_matches(|c| c == '<' || c == '>').to_string()
}

/// Rewrite inline `src="cid:<id>"` references to `data:` URIs using `map`
/// (keyed by [`normalize_cid`]). Unknown cids are left untouched — the browser
/// still can't fetch them, but nothing else is changed.
pub fn rewrite_cid_src(html: &str, map: &std::collections::HashMap<String, String>) -> String {
    CID_SRC
        .replace_all(html, |caps: &regex::Captures| {
            let cid = caps
                .get(1)
                .or_else(|| caps.get(2))
                .map(|m| m.as_str())
                .unwrap_or("");
            match map.get(&normalize_cid(cid)) {
                Some(data_uri) => format!("src=\"{data_uri}\""),
                None => caps.get(0).unwrap().as_str().to_string(),
            }
        })
        .into_owned()
}

#[cfg(test)]
mod cid_tests {
    use super::{normalize_cid, rewrite_cid_src};
    use std::collections::HashMap;

    #[test]
    fn rewrites_known_cid_and_leaves_unknown() {
        let mut map = HashMap::new();
        map.insert(
            "logo@x".to_string(),
            "data:image/png;base64,AAAA".to_string(),
        );
        let html = r#"<img src="cid:logo@x"><img src='cid:missing@y'>"#;
        let out = rewrite_cid_src(html, &map);
        assert!(out.contains(r#"src="data:image/png;base64,AAAA""#));
        assert!(
            out.contains("cid:missing@y"),
            "unknown cid untouched: {out}"
        );
    }

    #[test]
    fn matches_angle_bracketed_content_id() {
        let mut map = HashMap::new();
        map.insert(
            normalize_cid("<abc@host>"),
            "data:image/gif;base64,BBBB".to_string(),
        );
        let out = rewrite_cid_src(r#"<img src="cid:abc@host">"#, &map);
        assert!(out.contains("data:image/gif;base64,BBBB"));
    }
}

/// `d=` tag of a DKIM-Signature header (the signing domain).
static DKIM_DOMAIN: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r"(?i)\bd\s*=\s*([A-Za-z0-9._-]+)").unwrap());

/// Domain part of an email, or the input itself when it's already a bare domain.
fn domain_of(addr_or_domain: &str) -> &str {
    addr_or_domain.rsplit('@').next().unwrap_or(addr_or_domain)
}

/// Relaxed alignment (as in DMARC): equal, or one is a subdomain of the other
/// (`mailer.substack.com` aligns with `substack.com`). Case-insensitive.
fn domains_aligned(a: &str, b: &str) -> bool {
    let a = a.trim().trim_end_matches('.').to_ascii_lowercase();
    let b = b.trim().trim_end_matches('.').to_ascii_lowercase();
    a == b || a.ends_with(&format!(".{b}")) || b.ends_with(&format!(".{a}"))
}

/// The transmitting party to show as "via", when it doesn't align with From:.
/// Order: Sender: (self-declared), Return-Path (envelope sender, stamped by
/// the receiving server — a forged From: can't easily hide it), DKIM d=.
fn resolve_via(msg: &mail_parser::Message, from: Option<&Address>) -> Option<String> {
    let from_domain = from.map(|a| domain_of(&a.email).to_string());

    let sender_email = msg
        .sender()
        .and_then(|s| s.first())
        .and_then(addr_from)
        .map(|a| a.email);
    let return_path = match msg.return_path() {
        mail_parser::HeaderValue::Text(t) => Some(t.trim_matches(['<', '>', ' ']).to_string()),
        mail_parser::HeaderValue::TextList(l) => l
            .last()
            .map(|t| t.trim_matches(['<', '>', ' ']).to_string()),
        _ => None,
    }
    .filter(|s| !s.is_empty());
    let dkim_domain = msg
        .header("DKIM-Signature")
        .and_then(|h| h.as_text())
        .and_then(|s| DKIM_DOMAIN.captures(s))
        .map(|c| c[1].to_string());

    [sender_email, return_path, dkim_domain]
        .into_iter()
        .flatten()
        .find(|cand| match &from_domain {
            Some(fd) => !domains_aligned(domain_of(cand), fd),
            None => true,
        })
}

#[cfg(test)]
mod via_tests {
    use super::parse_message;

    fn via_of(raw: &str) -> Option<String> {
        parse_message(raw.as_bytes()).unwrap().headers.via
    }

    #[test]
    fn spoofed_from_surfaces_return_path() {
        // Claims to be next.com but was accepted from evil.example: the
        // receiver-stamped Return-Path exposes the real transmitting party.
        let raw = "Return-Path: <bounce@evil.example>\r\nFrom: Next <next@next.com>\r\nTo: a@b.com\r\nSubject: hi\r\n\r\nbody";
        assert_eq!(via_of(raw).as_deref(), Some("bounce@evil.example"));
    }

    #[test]
    fn aligned_subdomain_return_path_is_quiet() {
        let raw = "Return-Path: <bounces@mailer.next.com>\r\nFrom: next@next.com\r\nSubject: hi\r\n\r\nbody";
        assert_eq!(via_of(raw), None);
    }

    #[test]
    fn no_transmit_headers_is_quiet() {
        let raw = "From: next@next.com\r\nSubject: hi\r\n\r\nbody";
        assert_eq!(via_of(raw), None);
    }

    #[test]
    fn misaligned_dkim_domain_shows() {
        let raw = "DKIM-Signature: v=1; a=rsa-sha256; d=esp.example; s=sel; bh=xx\r\nFrom: news@next.com\r\nSubject: hi\r\n\r\nbody";
        assert_eq!(via_of(raw).as_deref(), Some("esp.example"));
    }

    #[test]
    fn sender_header_wins_over_return_path() {
        let raw = "Sender: list@groups.example\r\nReturn-Path: <b+tok@groups.example>\r\nFrom: alice@corp.com\r\nSubject: hi\r\n\r\nbody";
        assert_eq!(via_of(raw).as_deref(), Some("list@groups.example"));
    }
}

#[cfg(test)]
mod automated_tests {
    use super::{parse_message, robot_sender};

    fn automated(raw: &str) -> bool {
        parse_message(raw.as_bytes()).unwrap().headers.is_automated
    }

    #[test]
    fn robot_local_part_is_automated_without_bulk_headers() {
        assert!(automated(
            "From: noreply@binh.ong\r\nSubject: New booking\r\n\r\nbody"
        ));
        assert!(automated(
            "From: notifications@example.com\r\nSubject: You've joined the group\r\n\r\nbody"
        ));
    }

    #[test]
    fn exchange_ndr_is_automated() {
        // Exchange NDR sender local-part, no bulk headers.
        assert!(automated(
            "From: MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@corp.com\r\nSubject: Undeliverable: hi\r\n\r\nbody"
        ));
        // DSN envelope content type.
        assert!(automated(
            "From: odd-sender@corp.com\r\nContent-Type: multipart/report; report-type=delivery-status; boundary=b\r\nSubject: Undeliverable: hi\r\n\r\nbody"
        ));
    }

    #[test]
    fn plain_human_mail_is_not_automated() {
        assert!(!automated(
            "From: alice@example.com\r\nSubject: Lunch tomorrow?\r\n\r\nbody"
        ));
        // RFC 3834 defines the literal value "no" as explicitly not
        // automatically submitted. Some human-mail clients include it, so
        // treating mere header presence as automated would suppress a real
        // new-mail notification.
        assert!(!automated(
            "From: alice@example.com\r\nAuto-Submitted: no\r\nSubject: Still human\r\n\r\nbody"
        ));
    }

    #[test]
    fn generated_auto_submitted_mail_is_automated() {
        assert!(automated(
            "From: service@example.com\r\nAuto-Submitted: auto-generated\r\nSubject: Report\r\n\r\nbody"
        ));
    }

    #[test]
    fn robot_prefix_before_plus_only() {
        assert!(robot_sender("alerts+prod@x.com"));
        assert!(!robot_sender("alice+noreply@x.com"));
    }
}

/// Robot senders whose mail is automated even when it carries none of the
/// bulk-mail headers `is_automated` checks (cloud monitoring alarms, CI
/// notifications, and Exchange NDRs are often plain SMTP with a noreply-style
/// local-part).
pub fn robot_sender(email: &str) -> bool {
    let local = email
        .split('@')
        .next()
        .unwrap_or("")
        .split('+')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    const PREFIXES: &[&str] = &[
        "noreply",
        "no-reply",
        "no_reply",
        "donotreply",
        "do-not-reply",
        "notification",
        "notify",
        "alert",
        "alarm",
        "mailer-daemon",
        "postmaster",
        "bounce",
        "microsoftexchange",
    ];
    PREFIXES.iter().any(|p| local.starts_with(p))
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

    let from = msg.from().and_then(|f| f.first()).and_then(addr_from);
    let via = resolve_via(msg, from.as_ref());

    // multipart/report is the DSN/MDN envelope: bounces and read receipts.
    let is_report = msg
        .content_type()
        .map(|ct| {
            ct.ctype().eq_ignore_ascii_case("multipart")
                && ct
                    .subtype()
                    .is_some_and(|s| s.eq_ignore_ascii_case("report"))
        })
        .unwrap_or(false);

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
        || msg
            .header("Auto-Submitted")
            .and_then(|header| header.as_text())
            .is_some_and(|value| !value.trim().eq_ignore_ascii_case("no"))
        || msg.header("X-Autoreply").is_some()
        || msg.header("X-Failed-Recipients").is_some()
        || is_report
        || from.as_ref().is_some_and(|a| robot_sender(&a.email));

    ParsedHeaders {
        message_id: msg.message_id().map(|s| s.to_string()),
        subject: msg.subject().unwrap_or_default().to_string(),
        from,
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
        via,
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
    /// Rich body. Embedded `data:` images are converted to inline CID parts.
    pub body_html: Option<&'a str>,
    /// Message-ID of the message being replied to.
    pub in_reply_to: Option<&'a str>,
    /// Full reference chain (oldest first), including in_reply_to last.
    pub references: &'a [String],
    pub message_id_domain: &'a str,
    pub attachments: Vec<OutgoingAttachment>,
}

/// An image extracted from the HTML body, to be sent as an inline CID part.
struct InlineImage {
    mime_type: String,
    cid: String,
    bytes: Vec<u8>,
}

/// Replace `src="data:image/...;base64,..."` with `src="cid:..."` and return
/// the decoded images. Editors embed pasted screenshots as data URIs, but
/// many mail clients (Gmail included) strip those - CID parts survive.
fn extract_data_uri_images(html: &str) -> (String, Vec<InlineImage>) {
    use base64::Engine;
    const MARKER: &str = "src=\"data:image/";

    let mut out = String::with_capacity(html.len());
    let mut images = Vec::new();
    let mut rest = html;
    while let Some(pos) = rest.find(MARKER) {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 5..]; // past `src="`, starts at `data:image/`
        let Some(endq) = after.find('"') else {
            // unterminated attribute: keep the tail untouched
            out.push_str(&rest[pos..]);
            rest = "";
            break;
        };
        let uri = &after[..endq];
        let decoded = uri
            .strip_prefix("data:")
            .and_then(|u| u.split_once(";base64,"))
            .and_then(|(mime, b64)| {
                base64::engine::general_purpose::STANDARD
                    .decode(b64.trim())
                    .ok()
                    .map(|bytes| (mime.to_string(), bytes))
            });
        match decoded {
            Some((mime_type, bytes)) => {
                let cid = format!("img{}.{}", images.len() + 1, rand_token());
                out.push_str(&format!("src=\"cid:{cid}\""));
                images.push(InlineImage {
                    mime_type,
                    cid,
                    bytes,
                });
            }
            None => out.push_str(&rest[pos..pos + 5 + endq + 1]),
        }
        rest = &after[endq + 1..];
    }
    out.push_str(rest);
    (out, images)
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

    if let Some(html) = out.body_html {
        if !html.trim().is_empty() {
            let (html, inline_images) = extract_data_uri_images(html);
            builder = builder.html_body(html);
            for img in inline_images {
                builder = builder.inline(img.mime_type, img.cid, img.bytes);
            }
        }
    }

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

    fn outgoing<'a>(text: &'a str, html: Option<&'a str>) -> OutgoingMessage<'a> {
        OutgoingMessage {
            from: Address {
                name: Some("Me".into()),
                email: "me@example.com".into(),
            },
            to: &[],
            cc: &[],
            bcc: &[],
            subject: "s",
            body_text: text,
            body_html: html,
            in_reply_to: None,
            references: &[],
            message_id_domain: "example.com",
            attachments: Vec::new(),
        }
    }

    #[test]
    fn html_body_builds_multipart_alternative() {
        let (_, raw) = build_message(&outgoing("plain", Some("<b>rich</b>"))).unwrap();
        let s = String::from_utf8_lossy(&raw);
        assert!(s.contains("multipart/alternative"), "raw:\n{s}");
        assert!(s.contains("text/html"));
        assert!(s.contains("text/plain"));
    }

    #[test]
    fn text_only_message_stays_plain() {
        let (_, raw) = build_message(&outgoing("plain", None)).unwrap();
        let s = String::from_utf8_lossy(&raw);
        assert!(!s.contains("text/html"));
    }

    #[test]
    fn data_uri_images_become_cid_inline_parts() {
        // 1x1 transparent PNG
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        let html = format!(r#"before <img src="data:image/png;base64,{png_b64}" alt="dot"> after"#);
        let (rewritten, images) = extract_data_uri_images(&html);
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].mime_type, "image/png");
        assert!(rewritten.contains(&format!("src=\"cid:{}\"", images[0].cid)));
        assert!(!rewritten.contains("data:image/"));
        // PNG magic bytes survived the round-trip
        assert_eq!(&images[0].bytes[..4], &[0x89, b'P', b'N', b'G']);

        // And the full message embeds it as an inline part with a Content-ID.
        let (_, raw) = build_message(&outgoing("plain", Some(&html))).unwrap();
        let s = String::from_utf8_lossy(&raw);
        assert!(s.contains("Content-ID"), "raw:\n{s}");
        assert!(s.contains("image/png"));
        assert!(s.contains("inline"));
    }

    #[test]
    fn malformed_data_uri_is_left_alone() {
        let html = r#"<img src="data:image/png;base64,@@notbase64@@">"#;
        let (rewritten, images) = extract_data_uri_images(html);
        assert!(images.is_empty());
        assert_eq!(rewritten, html);
    }
}
