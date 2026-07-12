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
        if let Some(v) = token.strip_prefix("from:") {
            if !v.is_empty() {
                q.from = Some(v.to_string());
            }
        } else if let Some(v) = token.strip_prefix("to:") {
            if !v.is_empty() {
                q.to = Some(v.to_string());
            }
        } else if let Some(v) = token.strip_prefix("in:") {
            let role = match v {
                "inbox" => "inbox",
                "sent" => "sent",
                "drafts" => "drafts",
                "trash" => "trash",
                "spam" => "spam",
                "archive" | "done" => "archive",
                _ => continue,
            };
            q.in_folder = Some(role.to_string());
        } else if let Some(v) = token.strip_prefix("is:") {
            match v {
                "unread" => q.is_unread = Some(true),
                "starred" => q.is_starred = Some(true),
                _ => {}
            }
        } else if let Some(v) = token.strip_prefix("has:") {
            if v == "attachment" {
                q.has_attachment = Some(true);
            }
        } else {
            // Escape FTS special syntax by quoting; add * for prefix matching.
            let clean: String = token
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '@' || *c == '.' || *c == '-' || *c == '_')
                .collect();
            if !clean.is_empty() {
                fts_terms.push(fts_term(&clean));
                text_terms.push(clean);
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
    fn leading_d_expands_to_dj_variant() {
        let q = parse("don dep");
        assert_eq!(
            q.fts,
            "(\"don\"* OR \"đon\"*) AND (\"dep\"* OR \"đep\"*)"
        );
        assert_eq!(
            q.fts_or,
            "(\"don\"* OR \"đon\"*) OR (\"dep\"* OR \"đep\"*)"
        );
    }

    #[test]
    fn fold_removes_accents() {
        assert_eq!(fold("Bé Dọn Dẹp"), "be don dep");
    }
}
