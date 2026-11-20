//! vCard 3.0 / 4.0 (RFC 2426 / RFC 6350), plus the 2.1 habits still found in
//! exported address books, reduced to what a mail client needs: names, every
//! email address with its type, phone numbers, organization and title.
//! Photos, addresses and everything else are skipped.
//!
//! Handles line folding, backslash escapes, quoted and bare (2.1) parameters,
//! comma-separated TYPE lists, QUOTED-PRINTABLE values with a CHARSET, and
//! grouped properties (`item1.EMAIL` labelled by `item1.X-ABLabel`).

use std::collections::HashMap;

use crate::models::CardPhone;

/// One email address on a card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardAddress {
    /// Lowercased address.
    pub email: String,
    /// TYPE (work/home/...) or the Apple label; None when untyped.
    pub kind: Option<String>,
    /// Marked preferred (TYPE=pref or PREF=1).
    pub pref: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Card {
    pub uid: Option<String>,
    /// FN as written.
    pub formatted_name: Option<String>,
    /// N rendered as "Prefix Given Middle Family Suffix".
    pub structured_name: Option<String>,
    pub nickname: Option<String>,
    pub org: Option<String>,
    pub title: Option<String>,
    pub emails: Vec<CardAddress>,
    pub phones: Vec<CardPhone>,
    /// KIND:group (4.0) or X-ADDRESSBOOKSERVER-KIND:group (Apple 3.0): a
    /// contact group, not a person.
    pub is_group: bool,
}

impl Card {
    /// The name to show for this card: FN, else N, else nickname, else
    /// organization.
    pub fn display_name(&self) -> Option<String> {
        self.formatted_name
            .clone()
            .or_else(|| self.structured_name.clone())
            .or_else(|| self.nickname.clone())
            .or_else(|| self.org.clone())
    }
}

/// One content line split into its parts.
struct Prop {
    /// Lowercased group (`item1` in `item1.EMAIL`).
    group: Option<String>,
    /// Uppercased property name.
    name: String,
    /// Lowercased TYPE values, including 2.1 bare parameters.
    types: Vec<String>,
    /// Other parameters: uppercased key, unquoted value.
    params: Vec<(String, String)>,
    value: String,
}

impl Prop {
    fn param(&self, key: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
}

/// Parse the first vCard in `text`. None when there is no BEGIN:VCARD.
pub fn parse(text: &str) -> Option<Card> {
    let mut card: Option<Card> = None;
    let mut depth = 0usize;
    // Groups of EMAIL/TEL entries, parallel to card.emails / card.phones, so
    // an X-ABLabel that appears after its property can still label it.
    let mut email_groups: Vec<Option<String>> = Vec::new();
    let mut phone_groups: Vec<Option<String>> = Vec::new();
    let mut labels: HashMap<String, String> = HashMap::new();

    for line in unfold(text) {
        let Some(prop) = split_line(&line) else {
            continue;
        };
        let is_vcard = prop.value.trim().eq_ignore_ascii_case("VCARD");
        match prop.name.as_str() {
            "BEGIN" if is_vcard => {
                depth += 1;
                if depth == 1 {
                    if card.is_some() {
                        break; // only the first card of a multi-card body
                    }
                    card = Some(Card::default());
                }
                continue;
            }
            "END" if is_vcard => {
                depth = depth.saturating_sub(1);
                if depth == 0 && card.is_some() {
                    break;
                }
                continue;
            }
            _ => {}
        }
        // Lines outside BEGIN/END, or inside a nested (2.1 AGENT) card.
        if depth != 1 {
            continue;
        }
        let Some(card) = card.as_mut() else {
            continue;
        };
        let Some(value) = decode_value(&prop) else {
            continue; // binary (base64) payloads: photos, keys, sounds
        };

        match prop.name.as_str() {
            "UID" => card.uid = clean(&unescape(&value)),
            "FN" => card.formatted_name = clean(&unescape(&value)),
            "N" => card.structured_name = structured_name(&value),
            "NICKNAME" => card.nickname = joined(split_raw(&value, ','), ", "),
            "ORG" => card.org = joined(split_raw(&value, ';'), ", "),
            "TITLE" => card.title = clean(&unescape(&value)),
            "KIND" | "X-ADDRESSBOOKSERVER-KIND" => {
                card.is_group = value.trim().eq_ignore_ascii_case("group");
            }
            "EMAIL" => {
                let Some(email) = email_value(&unescape(&value)) else {
                    continue;
                };
                let pref = is_pref(&prop);
                if let Some(existing) = card.emails.iter_mut().find(|e| e.email == email) {
                    existing.pref |= pref;
                    continue;
                }
                card.emails.push(CardAddress {
                    email,
                    kind: kind_of(&prop.types, &["internet", "pref", "x400", "x-internet"]),
                    pref,
                });
                email_groups.push(prop.group.clone());
            }
            "TEL" => {
                let number = unescape(&value);
                let number = strip_prefix_ci(number.trim(), "tel:").trim().to_string();
                if number.is_empty() {
                    continue;
                }
                card.phones.push(CardPhone {
                    number,
                    kind: kind_of(&prop.types, &["voice", "pref"]),
                });
                phone_groups.push(prop.group.clone());
            }
            "X-ABLABEL" => {
                if let (Some(group), Some(label)) = (&prop.group, ab_label(&unescape(&value))) {
                    labels.insert(group.clone(), label);
                }
            }
            _ => {}
        }
    }

    let mut card = card?;
    // A label names the entry more precisely than a generic TYPE.
    for (entry, group) in card.emails.iter_mut().zip(&email_groups) {
        if let Some(label) = group.as_ref().and_then(|g| labels.get(g)) {
            entry.kind = Some(label.clone());
        }
    }
    for (entry, group) in card.phones.iter_mut().zip(&phone_groups) {
        if let Some(label) = group.as_ref().and_then(|g| labels.get(g)) {
            entry.kind = Some(label.clone());
        }
    }
    Some(card)
}

/// Unfold content lines: a line starting with a space or tab continues the
/// previous one (RFC 6350 §3.2). vCard 2.1 QUOTED-PRINTABLE values instead
/// continue after a trailing '=' soft line break.
fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut qp_open = false;
    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        match out.last_mut() {
            Some(last) if qp_open => last.push_str(line),
            Some(last) if line.starts_with([' ', '\t']) => last.push_str(&line[1..]),
            _ => {
                if line.trim().is_empty() {
                    continue;
                }
                out.push(line.to_string());
            }
        }
        qp_open = false;
        if let Some(last) = out.last_mut()
            && last.ends_with('=')
            && is_quoted_printable(last)
        {
            last.pop();
            qp_open = true;
        }
    }
    out
}

/// Whether the name/parameter part of a raw line declares QUOTED-PRINTABLE.
fn is_quoted_printable(line: &str) -> bool {
    let head = match line.find(':') {
        Some(i) => &line[..i],
        None => line,
    };
    head.to_ascii_uppercase().contains("QUOTED-PRINTABLE")
}

/// `[group.]NAME *(;PARAM) : VALUE`. The name/parameter section ends at the
/// first ':' outside double quotes.
fn split_line(line: &str) -> Option<Prop> {
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
    let (head, value) = (&line[..colon], &line[colon + 1..]);

    let mut parts: Vec<String> = vec![String::new()];
    let mut quoted = false;
    for ch in head.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                parts.last_mut()?.push(ch);
            }
            ';' if !quoted => parts.push(String::new()),
            _ => parts.last_mut()?.push(ch),
        }
    }
    let mut parts = parts.into_iter();
    let full_name = parts.next()?;
    let (group, name) = match full_name.rsplit_once('.') {
        Some((g, n)) => (Some(g.trim().to_ascii_lowercase()), n),
        None => (None, full_name.as_str()),
    };
    let name = name.trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }

    let mut types = Vec::new();
    let mut params = Vec::new();
    for p in parts {
        match p.split_once('=') {
            Some((k, v)) => {
                let key = k.trim().to_ascii_uppercase();
                if key == "TYPE" {
                    types.extend(param_values(v));
                } else {
                    params.push((key, v.trim().trim_matches('"').to_string()));
                }
            }
            // vCard 2.1 bare parameter: an encoding, or else a type.
            None => {
                let bare = p.trim().trim_matches('"');
                let upper = bare.to_ascii_uppercase();
                if matches!(upper.as_str(), "QUOTED-PRINTABLE" | "BASE64" | "B" | "8BIT") {
                    params.push(("ENCODING".into(), upper));
                } else if !bare.is_empty() {
                    types.push(bare.to_ascii_lowercase());
                }
            }
        }
    }
    Some(Prop {
        group,
        name,
        types,
        params,
        value: value.to_string(),
    })
}

/// `work,voice`, `"work,voice"` or a single value, lowercased.
fn param_values(v: &str) -> Vec<String> {
    v.split(',')
        .map(|s| s.trim().trim_matches('"').trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

/// The property value as text: QUOTED-PRINTABLE decoded through its CHARSET,
/// None for base64 binaries.
fn decode_value(prop: &Prop) -> Option<String> {
    let encoding = prop.param("ENCODING").map(str::to_ascii_uppercase);
    match encoding.as_deref() {
        Some("B") | Some("BASE64") => None,
        Some("QUOTED-PRINTABLE") => {
            let bytes = decode_qp(&prop.value);
            Some(decode_charset(&bytes, prop.param("CHARSET")))
        }
        _ => Some(prop.value.clone()),
    }
}

fn decode_qp(v: &str) -> Vec<u8> {
    let b = v.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'=' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(byte) = hex {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

fn decode_charset(bytes: &[u8], charset: Option<&str>) -> String {
    match charset.map(str::trim).filter(|c| !c.is_empty()) {
        Some(cs) if !cs.eq_ignore_ascii_case("utf-8") && !cs.eq_ignore_ascii_case("utf8") => {
            match mail_parser::decoders::charsets::map::charset_decoder(cs.as_bytes()) {
                Some(decode) => decode(bytes),
                None => String::from_utf8_lossy(bytes).into_owned(),
            }
        }
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// Split on `sep` where it isn't backslash-escaped; parts keep their escapes.
fn split_raw(v: &str, sep: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut escaped = false;
    for (i, c) in v.char_indices() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == sep {
            parts.push(&v[start..i]);
            start = i + c.len_utf8();
        }
    }
    parts.push(&v[start..]);
    parts
}

/// RFC 6350 §3.4 text escapes: `\n`/`\N` newline, `\,` `\;` `\\` literal.
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

/// Collapse whitespace (escaped newlines included) to single spaces; None
/// when nothing is left.
fn clean(v: &str) -> Option<String> {
    let s = v.split_whitespace().collect::<Vec<_>>().join(" ");
    (!s.is_empty()).then_some(s)
}

/// Unescape and clean each part, keep the non-empty ones, join with `sep`.
fn joined(parts: Vec<&str>, sep: &str) -> Option<String> {
    let kept: Vec<String> = parts
        .into_iter()
        .filter_map(|p| clean(&unescape(p)))
        .collect();
    (!kept.is_empty()).then(|| kept.join(sep))
}

/// N = Family;Given;Additional;Prefix;Suffix (each possibly a comma list),
/// rendered in reading order.
fn structured_name(v: &str) -> Option<String> {
    let comps = split_raw(v, ';');
    let comp =
        |i: usize| -> Option<String> { comps.get(i).and_then(|c| joined(split_raw(c, ','), " ")) };
    let ordered: Vec<String> = [comp(3), comp(1), comp(2), comp(0), comp(4)]
        .into_iter()
        .flatten()
        .collect();
    (!ordered.is_empty()).then(|| ordered.join(" "))
}

/// A usable, lowercased address from an EMAIL value (`mailto:` and
/// `Name <addr>` forms tolerated).
fn email_value(v: &str) -> Option<String> {
    let mut s = strip_prefix_ci(v.trim(), "mailto:").trim();
    if let (Some(open), Some(close)) = (s.find('<'), s.rfind('>'))
        && open < close
    {
        s = s[open + 1..close].trim();
    }
    let ok = s.contains('@') && !s.starts_with('@') && !s.ends_with('@');
    (ok && !s.chars().any(char::is_whitespace)).then(|| s.to_lowercase())
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> &'a str {
    match s.get(..prefix.len()) {
        Some(head) if head.eq_ignore_ascii_case(prefix) => &s[prefix.len()..],
        _ => s,
    }
}

/// TYPE=pref (3.0) or PREF=1 (4.0, where 1 is the most preferred).
fn is_pref(prop: &Prop) -> bool {
    prop.types.iter().any(|t| t == "pref") || prop.param("PREF").is_some_and(|p| p.trim() == "1")
}

/// The meaningful TYPE values, comma-joined; None when only filler types
/// (internet, voice, pref) were given.
fn kind_of(types: &[String], filler: &[&str]) -> Option<String> {
    let kept: Vec<&str> = types
        .iter()
        .map(String::as_str)
        .filter(|t| !filler.contains(t))
        .collect();
    (!kept.is_empty()).then(|| kept.join(","))
}

/// Apple's `X-ABLabel`: `_$!<Mobile>!$_` for built-in labels (lowercased to
/// match TYPE values), free text for custom ones.
fn ab_label(v: &str) -> Option<String> {
    let v = v.trim();
    if let Some(inner) = v.strip_prefix("_$!<").and_then(|s| s.strip_suffix(">!$_")) {
        return clean(inner).map(|s| s.to_lowercase());
    }
    clean(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(card: &Card) -> Vec<(&str, Option<&str>, bool)> {
        card.emails
            .iter()
            .map(|e| (e.email.as_str(), e.kind.as_deref(), e.pref))
            .collect()
    }

    #[test]
    fn parses_vcard_3() {
        let card = parse(
            "BEGIN:VCARD\r\n\
             VERSION:3.0\r\n\
             UID:abc-123\r\n\
             FN:Jane Doe\r\n\
             N:Doe;Jane;Q.;Dr.;PhD\r\n\
             NICKNAME:JD,Janie\r\n\
             ORG:Acme\\, Inc.;Research\r\n\
             TITLE:Chief\\nScientist\r\n\
             EMAIL;TYPE=INTERNET,WORK,pref:Jane.Doe@Acme.com\r\n\
             EMAIL;TYPE=HOME:jane@home.example\r\n\
             TEL;TYPE=CELL:+1 555 0100\r\n\
             TEL;TYPE=WORK,VOICE:+1 555 0199\r\n\
             END:VCARD\r\n",
        )
        .unwrap();
        assert_eq!(card.uid.as_deref(), Some("abc-123"));
        assert_eq!(card.formatted_name.as_deref(), Some("Jane Doe"));
        assert_eq!(card.structured_name.as_deref(), Some("Dr. Jane Q. Doe PhD"));
        assert_eq!(card.nickname.as_deref(), Some("JD, Janie"));
        assert_eq!(card.org.as_deref(), Some("Acme, Inc., Research"));
        assert_eq!(card.title.as_deref(), Some("Chief Scientist"));
        assert_eq!(
            kinds(&card),
            [
                ("jane.doe@acme.com", Some("work"), true),
                ("jane@home.example", Some("home"), false)
            ]
        );
        assert_eq!(
            card.phones,
            [
                CardPhone {
                    number: "+1 555 0100".into(),
                    kind: Some("cell".into())
                },
                CardPhone {
                    number: "+1 555 0199".into(),
                    kind: Some("work".into())
                },
            ]
        );
        assert!(!card.is_group);
        assert_eq!(card.display_name().as_deref(), Some("Jane Doe"));
    }

    #[test]
    fn parses_vcard_4_params_and_uris() {
        let card = parse(
            "BEGIN:VCARD\n\
             VERSION:4.0\n\
             FN:Lê Văn Bảo\n\
             EMAIL;TYPE=\"work,internet\";PREF=1:bao@example.vn\n\
             EMAIL;TYPE=home;PREF=2:mailto:bao.home@example.vn\n\
             TEL;VALUE=uri;TYPE=\"voice,cell\":tel:+84-90-000-0000\n\
             PHOTO:https://example.vn/bao.jpg\n\
             END:VCARD\n",
        )
        .unwrap();
        assert_eq!(card.formatted_name.as_deref(), Some("Lê Văn Bảo"));
        assert_eq!(
            kinds(&card),
            [
                ("bao@example.vn", Some("work"), true),
                ("bao.home@example.vn", Some("home"), false)
            ]
        );
        assert_eq!(card.phones[0].number, "+84-90-000-0000");
        assert_eq!(card.phones[0].kind.as_deref(), Some("cell"));
    }

    #[test]
    fn unfolds_continuation_lines_and_skips_inline_photos() {
        let card = parse(
            "BEGIN:VCARD\r\n\
             VERSION:3.0\r\n\
             FN:Maximilian Alexander\r\n  von Humboldt-Stra\r\n \u{df}e\r\n\
             PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcG\r\n BwgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5\r\n PTgyPC4zNDL/==\r\n\
             EMAIL:max@example.de\r\n\
             END:VCARD\r\n",
        )
        .unwrap();
        // Folding drops exactly one leading whitespace character.
        assert_eq!(
            card.formatted_name.as_deref(),
            Some("Maximilian Alexander von Humboldt-Straße")
        );
        assert_eq!(kinds(&card), [("max@example.de", None, false)]);
    }

    #[test]
    fn grouped_properties_take_apple_labels() {
        let card = parse(
            "BEGIN:VCARD\n\
             VERSION:3.0\n\
             N:Appleseed;Johnny;;;\n\
             item1.EMAIL;type=INTERNET;type=pref:johnny@icloud.com\n\
             item1.X-ABLabel:_$!<Other>!$_\n\
             item2.X-ABLabel:Side project\n\
             item2.EMAIL;type=INTERNET:j@side.dev\n\
             item3.TEL:+1 555 0111\n\
             item3.X-ABLabel:_$!<Mobile>!$_\n\
             END:VCARD\n",
        )
        .unwrap();
        assert_eq!(card.formatted_name, None);
        assert_eq!(card.display_name().as_deref(), Some("Johnny Appleseed"));
        assert_eq!(
            kinds(&card),
            [
                ("johnny@icloud.com", Some("other"), true),
                ("j@side.dev", Some("Side project"), false)
            ]
        );
        assert_eq!(card.phones[0].kind.as_deref(), Some("mobile"));
    }

    #[test]
    fn vcard_21_quoted_printable_with_charset() {
        let card = parse(
            "BEGIN:VCARD\r\n\
             VERSION:2.1\r\n\
             N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrgen\r\n\
             FN;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:J=FCrgen M=FCller =\r\n\
             (B=FCro)\r\n\
             EMAIL;INTERNET;WORK:juergen@example.de\r\n\
             TEL;CELL;VOICE:0170 1234567\r\n\
             END:VCARD\r\n",
        )
        .unwrap();
        assert_eq!(card.formatted_name.as_deref(), Some("Jürgen Müller (Büro)"));
        assert_eq!(card.structured_name.as_deref(), Some("Jürgen Müller"));
        assert_eq!(kinds(&card), [("juergen@example.de", Some("work"), false)]);
        assert_eq!(card.phones[0].kind.as_deref(), Some("cell"));
    }

    #[test]
    fn display_name_falls_back_to_org_and_groups_are_flagged() {
        let org_only = parse(
            "BEGIN:VCARD\nVERSION:4.0\nFN:\nORG:Acme Support\nEMAIL:help@acme.com\nEND:VCARD",
        )
        .unwrap();
        assert_eq!(org_only.display_name().as_deref(), Some("Acme Support"));

        let group = parse(
            "BEGIN:VCARD\nVERSION:3.0\nFN:Book club\nX-ADDRESSBOOKSERVER-KIND:group\nX-ADDRESSBOOKSERVER-MEMBER:urn:uuid:1\nEND:VCARD",
        )
        .unwrap();
        assert!(group.is_group);
    }

    #[test]
    fn tolerates_junk_and_duplicates() {
        assert!(parse("").is_none());
        assert!(parse("not a vcard at all").is_none());
        let card = parse(
            "garbage before\n\
             BEGIN:VCARD\n\
             VERSION:3.0\n\
             FN:Ann\n\
             EMAIL:not-an-address\n\
             EMAIL:ann@example.com\n\
             EMAIL;TYPE=pref:ANN@example.com\n\
             EMAIL:Ann Example <ann.alt@example.com>\n\
             no colon here\n\
             TEL:\n\
             END:VCARD\n\
             BEGIN:VCARD\n\
             FN:Second card ignored\n\
             END:VCARD\n",
        )
        .unwrap();
        assert_eq!(card.formatted_name.as_deref(), Some("Ann"));
        assert_eq!(
            kinds(&card),
            [
                ("ann@example.com", None, true),
                ("ann.alt@example.com", None, false)
            ]
        );
        assert!(card.phones.is_empty());
    }

    #[test]
    fn quoted_parameter_values_may_hold_colons_and_semicolons() {
        let card = parse(
            "BEGIN:VCARD\nVERSION:4.0\nFN:Q\nEMAIL;X-NOTE=\"a:b;c\";TYPE=work:q@example.com\nEND:VCARD",
        )
        .unwrap();
        assert_eq!(kinds(&card), [("q@example.com", Some("work"), false)]);
    }
}
