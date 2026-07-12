//! Search query parser: extracts `from:` / `to:` / `in:` / `is:` / `has:`
//! operators, everything else becomes an FTS5 prefix query.

/// Lowercase and strip diacritics for accent-insensitive matching, so that
/// unaccented input ("be don dep") matches accented text ("Bé Dọn Dẹp").
pub fn fold(s: &str) -> String {
    deunicode::deunicode(s).to_lowercase()
}

#[derive(Debug, Default, Clone)]
pub struct ParsedQuery {
    pub fts: String,
    /// Same terms joined with OR - the relaxed fallback used when the
    /// all-terms-must-match query comes up empty.
    pub fts_or: String,
    /// Free-text terms with operators stripped, joined by spaces and unquoted -
    /// used as the semantic-search embedding query.
    pub text: String,
    pub from: Option<String>,
    pub to: Option<String>,
    pub in_folder: Option<String>,
    pub is_unread: Option<bool>,
    pub is_starred: Option<bool>,
    pub has_attachment: Option<bool>,
}

pub fn parse(input: &str) -> ParsedQuery {
    let mut q = ParsedQuery::default();
    let mut fts_terms: Vec<String> = Vec::new();
    let mut text_terms: Vec<String> = Vec::new();

    for token in input.split_whitespace() {
        // Operators are case-insensitive on both the key ("In:" == "in:") and
        // the value ("in:Sent" == "in:sent"); users type them however they like.
        let (key, value) = match token.split_once(':') {
            Some((k, v)) => (k.to_ascii_lowercase(), v),
            None => (String::new(), ""),
        };
        match key.as_str() {
            // Address operators keep the value's original case (matched
            // case-insensitively downstream); a bare "from:" is a no-op.
            "from" => {
                if !value.is_empty() {
                    q.from = Some(value.to_string());
                }
            }
            "to" => {
                if !value.is_empty() {
                    q.to = Some(value.to_string());
                }
            }
            "in" => {
                match value.to_ascii_lowercase().as_str() {
                    "inbox" => q.in_folder = Some("inbox".into()),
                    "sent" => q.in_folder = Some("sent".into()),
                    "drafts" => q.in_folder = Some("drafts".into()),
                    "trash" => q.in_folder = Some("trash".into()),
                    "spam" => q.in_folder = Some("spam".into()),
                    "archive" | "done" => q.in_folder = Some("archive".into()),
                    _ => {} // unknown folder: ignore the operator, drop the token
                }
            }
            "is" => match value.to_ascii_lowercase().as_str() {
                "unread" => q.is_unread = Some(true),
                "starred" => q.is_starred = Some(true),
                _ => {}
            },
            "has" => {
                if value.eq_ignore_ascii_case("attachment") {
                    q.has_attachment = Some(true);
                }
            }
            // Not an operator (includes non-operator tokens with ':' like "12:30").
            _ => {
                // Escape FTS special syntax by quoting; add * for prefix matching.
                let clean: String = token
                    .chars()
                    .filter(|c| {
                        c.is_alphanumeric() || *c == '@' || *c == '.' || *c == '-' || *c == '_'
                    })
                    .collect();
                if !clean.is_empty() {
                    fts_terms.push(fts_term(&clean));
                    text_terms.push(clean);
                }
            }
        }
    }

    // Explicit AND: FTS5 rejects implicit-AND juxtaposition of the
    // parenthesized groups fts_term() can produce.
    q.fts = fts_terms.join(" AND ");
    q.fts_or = fts_terms.join(" OR ");
    q.text = text_terms.join(" ");
    q
}

/// One FTS5 prefix term for a cleaned token. The index tokenizer
/// (unicode61 remove_diacritics 2) folds Vietnamese vowel diacritics but not
/// đ/Đ - a distinct letter, not a combining mark - so a leading unaccented
/// "d" also tries the "đ" variant ("don" matches both "dọn" and "đơn").
fn fts_term(clean: &str) -> String {
    if let Some(rest) = clean.strip_prefix(['d', 'D']) {
        format!("(\"{clean}\"* OR \"đ{rest}\"*)")
    } else {
        format!("\"{clean}\"*")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_operators() {
        let q = parse("from:alice in:inbox is:unread has:attachment quarterly report");
        assert_eq!(q.from.as_deref(), Some("alice"));
        assert_eq!(q.in_folder.as_deref(), Some("inbox"));
        assert_eq!(q.is_unread, Some(true));
        assert_eq!(q.has_attachment, Some(true));
        assert_eq!(q.fts, "\"quarterly\"* AND \"report\"*");
    }

    #[test]
    fn operators_are_case_insensitive() {
        // "in:Sent" (capitalised) must resolve the same as "in:sent".
        let q = parse("in:Sent");
        assert_eq!(q.in_folder.as_deref(), Some("sent"));
        assert!(q.fts.is_empty(), "operator token must not leak into FTS");

        let q = parse("IN:INBOX IS:Unread HAS:Attachment");
        assert_eq!(q.in_folder.as_deref(), Some("inbox"));
        assert_eq!(q.is_unread, Some(true));
        assert_eq!(q.has_attachment, Some(true));
    }

    #[test]
    fn non_operator_colon_token_is_free_text() {
        // A time like "12:30" is not an operator and stays searchable.
        let q = parse("12:30");
        assert_eq!(q.fts, "\"1230\"*");
    }

    #[test]
    fn leading_d_expands_to_dj_variant() {
        let q = parse("don dep");
        assert_eq!(q.fts, "(\"don\"* OR \"đon\"*) AND (\"dep\"* OR \"đep\"*)");
        assert_eq!(q.fts_or, "(\"don\"* OR \"đon\"*) OR (\"dep\"* OR \"đep\"*)");
    }

    #[test]
    fn fold_removes_accents() {
        assert_eq!(fold("Bé Dọn Dẹp"), "be don dep");
    }
}
