//! Search query parser: extracts `from:` / `to:` / `label:` / `in:` / `is:` /
//! `has:` / `subject:` / `body:` / `exclude:` / date (`after:`, `before:`,
//! `between:`, `last:`, `older_than:`) / `sort:` operators; everything else
//! becomes an FTS5 prefix query. `exclude:term` (and the Gmail-style `-term`)
//! drops any thread whose messages match `term` from the results.
//!
//! Besides the query itself, parsing records a `Chip` per understood operator
//! and a `QueryWarning` per token it could not use (a misspelt operator, a bad
//! value), each with its UTF-16 span in the input, so the UI can explain the
//! query as it is typed and remove a filter by its span.

use chrono::{Datelike, NaiveDate, TimeZone};
use serde::Serialize;

/// Lowercase and strip diacritics for accent-insensitive matching, so that
/// unaccented input ("be don dep") matches accented text ("Bé Dọn Dẹp").
pub fn fold(s: &str) -> String {
    deunicode::deunicode(s).to_lowercase()
}

/// Result ordering requested with `sort:`. Relevance is the default.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Sort {
    #[default]
    Relevance,
    Newest,
    Oldest,
}

/// One understood operator, for the explain row. `kind` is the operator name
/// (`from`, `label`, `last`, ...), `value` its value as typed, and
/// `start..end` its UTF-16 span in the input (what JS string indices use).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chip {
    pub kind: &'static str,
    pub value: String,
    pub start: usize,
    pub end: usize,
}

/// A token the parser could not use. `kind` is `unknown_operator` (a
/// misspelt operator such as `lable:`), `bad_value` (`in:inbx`, a bad date)
/// or `unknown_label` (filled in later, against the label table).
/// `suggestion` is the closest valid spelling, when there is one.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryWarning {
    pub kind: &'static str,
    pub token: String,
    pub suggestion: Option<String>,
    pub start: usize,
    pub end: usize,
}

/// What a query will do, in structured form - the payload behind the search
/// screen's chips and one-line summary.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchExplain {
    pub chips: Vec<Chip>,
    pub warnings: Vec<QueryWarning>,
    /// Free-text words and phrases that must appear.
    pub terms: Vec<String>,
    pub after_ms: Option<i64>,
    pub before_ms: Option<i64>,
    pub sort: Sort,
}

#[derive(Debug, Default, Clone)]
pub struct ParsedQuery {
    pub fts: String,
    /// Same terms joined with OR - matches mail containing only some of the
    /// terms, ranked below mail that contains all of them.
    pub fts_or: String,
    /// Excluded terms (`exclude:foo` / `-foo`) joined with OR, as an FTS5 match
    /// string. A thread is dropped when any of its messages matches this. Empty
    /// when the query has no exclusions.
    pub fts_not: String,
    /// Free-text terms with operators stripped, joined by spaces and unquoted -
    /// used as the semantic-search embedding query.
    pub text: String,
    /// Folded (lowercase, diacritic-stripped) free-text terms - used to boost
    /// results whose sender name/address matches the query.
    pub terms: Vec<String>,
    /// The same terms lowercased but with diacritics kept, index-aligned with
    /// `terms`. Lets ranking prefer an exact-accent hit ("hùng" → "Hùng" over
    /// "Hưng") when the user typed accents.
    pub raw_terms: Vec<String>,
    /// Number of positive FTS terms (words, phrases, `subject:`/`body:` terms),
    /// so ranking can tell all-terms matches from partial ones.
    pub term_count: usize,
    pub from: Option<String>,
    /// `from:me` - only mail the user sent.
    pub from_me: bool,
    pub to: Option<String>,
    /// `label:name` values as typed; resolved against the label table by name,
    /// ignoring case and accents. Every listed label must be present.
    pub label: Vec<String>,
    pub in_folder: Option<String>,
    /// `Some(true)` for `is:unread`, `Some(false)` for `is:read`.
    pub is_unread: Option<bool>,
    pub is_starred: Option<bool>,
    /// `is:replied` - threads the user has sent a message in.
    pub is_replied: bool,
    pub has_attachment: Option<bool>,
    /// `has:label` - mail carrying any user label.
    pub has_label: bool,
    /// Inclusive lower bound on the message date (ms).
    pub after_ms: Option<i64>,
    /// Exclusive upper bound on the message date (ms).
    pub before_ms: Option<i64>,
    pub sort: Sort,
    pub chips: Vec<Chip>,
    pub warnings: Vec<QueryWarning>,
    /// Scope results to a single account. `None` searches every account. Not
    /// parsed from the query string - set by the caller from the UI's active
    /// account selection.
    pub account_id: Option<i64>,
}

impl ParsedQuery {
    /// The structured "what will this search do" summary for the UI.
    pub fn explain(&self) -> SearchExplain {
        SearchExplain {
            chips: self.chips.clone(),
            warnings: self.warnings.clone(),
            terms: self.raw_terms.clone(),
            after_ms: self.after_ms,
            before_ms: self.before_ms,
            sort: self.sort,
        }
    }
}

/// Every operator key the parser understands, for did-you-mean suggestions.
const OPERATORS: &[&str] = &[
    "from",
    "to",
    "label",
    "in",
    "is",
    "has",
    "subject",
    "body",
    "exclude",
    "after",
    "before",
    "between",
    "last",
    "newer_than",
    "older_than",
    "sort",
];
const IN_VALUES: &[&str] = &[
    "inbox", "sent", "drafts", "archive", "done", "trash", "spam",
];
const IS_VALUES: &[&str] = &["unread", "read", "starred", "replied"];
const HAS_VALUES: &[&str] = &["attachment", "label"];
const SORT_VALUES: &[&str] = &["newest", "oldest", "relevance"];
const LAST_VALUES: &[&str] = &["today", "7d", "30d", "week", "month", "year"];

/// A raw query token: a bare word or a `"quoted phrase"`. A phrase can be
/// scoped to an operator when it directly follows `subject:` / `body:` /
/// `from:` / `to:` / `label:`, e.g. `subject:"quarterly report"` carries
/// `Some("subject")`.
enum Token {
    Word(String),
    Phrase(Option<String>, String),
}

/// A token plus its UTF-16 span in the input.
struct Spanned {
    token: Token,
    start: usize,
    end: usize,
}

/// The operators that accept a quoted value, mapped to their name; anything
/// else is `None`. A `!` or `!!` case marker directly before the quote
/// (`body:!"phrase"`, `body:!!"Phrase"` - documented in the search help as
/// "ignore case" / "match case exactly") is tolerated here so the phrase
/// still gets column scoping; the marker itself is a no-op today since FTS5's
/// unicode61 tokenizer already folds case unconditionally; case-exact
/// matching isn't implemented.
fn scoped_col(token: &str) -> Option<&'static str> {
    let token = token
        .strip_suffix("!!")
        .or_else(|| token.strip_suffix('!'))
        .unwrap_or(token);
    match token.strip_suffix(':')?.to_ascii_lowercase().as_str() {
        "subject" => Some("subject"),
        "body" => Some("body"),
        "from" => Some("from"),
        "to" => Some("to"),
        "label" => Some("label"),
        _ => None,
    }
}

/// Split on whitespace, keeping double-quoted spans together as phrases.
/// An unterminated quote still yields a phrase from what follows it. Spans
/// are UTF-16 offsets and cover an operator prefix (`subject:"..."`) too.
fn tokenize(input: &str) -> Vec<Spanned> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    // Operator carried from a `subject:`/`label:`/... prefix into the phrase
    // that opens immediately after it.
    let mut pending_col: Option<String> = None;
    let mut start = 0usize;
    let mut pos = 0usize;
    for c in input.chars() {
        let width = c.len_utf16();
        match c {
            '"' => {
                if in_quote {
                    if !cur.is_empty() {
                        out.push(Spanned {
                            token: Token::Phrase(pending_col.take(), std::mem::take(&mut cur)),
                            start,
                            end: pos + width,
                        });
                    } else {
                        pending_col = None;
                    }
                    in_quote = false;
                } else {
                    // A bare operator right before the quote scopes it; the
                    // phrase's span keeps starting at the operator.
                    if !cur.is_empty() {
                        if let Some(col) = scoped_col(&cur) {
                            pending_col = Some(col.to_string());
                            cur.clear();
                        } else {
                            out.push(Spanned {
                                token: Token::Word(std::mem::take(&mut cur)),
                                start,
                                end: pos,
                            });
                            start = pos;
                        }
                    } else {
                        start = pos;
                    }
                    in_quote = true;
                }
            }
            c if c.is_whitespace() && !in_quote => {
                if !cur.is_empty() {
                    out.push(Spanned {
                        token: Token::Word(std::mem::take(&mut cur)),
                        start,
                        end: pos,
                    });
                }
            }
            c => {
                if cur.is_empty() && !in_quote && pending_col.is_none() {
                    start = pos;
                }
                cur.push(c);
            }
        }
        pos += width;
    }
    if !cur.is_empty() {
        let token = if in_quote {
            Token::Phrase(pending_col.take(), cur)
        } else {
            Token::Word(cur)
        };
        out.push(Spanned {
            token,
            start,
            end: pos,
        });
    }
    out
}

/// Optimal-string-alignment edit distance (Levenshtein plus adjacent
/// transpositions, so "lable" is one edit from "label").
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut v = (d[i - 1][j] + 1)
                .min(d[i][j - 1] + 1)
                .min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                v = v.min(d[i - 2][j - 2] + 1);
            }
            d[i][j] = v;
        }
    }
    d[a.len()][b.len()]
}

/// The closest of `options` to `word`, if it is a plausible typo: one edit for
/// short words, two for longer ones, or `word` is a prefix of the option.
pub fn closest<'a>(word: &str, options: &[&'a str]) -> Option<&'a str> {
    let word = word.to_lowercase();
    if word.is_empty() {
        return None;
    }
    let max = if word.chars().count() <= 5 { 1 } else { 2 };
    options
        .iter()
        .map(|o| (edit_distance(&word, o), *o))
        .filter(|(d, o)| *d <= max || (word.len() >= 2 && o.starts_with(&word)))
        .min_by_key(|(d, _)| *d)
        .map(|(_, o)| o)
}

/// Local midnight of `date`, in ms.
fn local_midnight(date: NaiveDate) -> Option<i64> {
    chrono::Local
        .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
        .earliest()
        .map(|d| d.timestamp_millis())
}

/// A calendar date or period: `YYYY-MM-DD` (or with `/`), `YYYY-MM` or
/// `YYYY`. Returns the local-midnight start of the period and of the period
/// after it, so `before:2026-03` excludes March and `between:..:2026-03`
/// includes all of it.
fn parse_period(value: &str) -> Option<(i64, i64)> {
    let parts: Vec<&str> = value.split(['-', '/', '.']).collect();
    let num = |s: &str| s.parse::<i32>().ok();
    let (start, next) = match parts.as_slice() {
        [y, m, d] => {
            let start = NaiveDate::from_ymd_opt(num(y)?, num(m)? as u32, num(d)? as u32)?;
            (start, start.succ_opt()?)
        }
        [y, m] => {
            let start = NaiveDate::from_ymd_opt(num(y)?, num(m)? as u32, 1)?;
            let next = if start.month() == 12 {
                NaiveDate::from_ymd_opt(start.year() + 1, 1, 1)?
            } else {
                NaiveDate::from_ymd_opt(start.year(), start.month() + 1, 1)?
            };
            (start, next)
        }
        [y] if y.len() == 4 => {
            let y = num(y)?;
            (
                NaiveDate::from_ymd_opt(y, 1, 1)?,
                NaiveDate::from_ymd_opt(y + 1, 1, 1)?,
            )
        }
        _ => return None,
    };
    Some((local_midnight(start)?, local_midnight(next)?))
}

/// The start of a relative window ending now: `today`, `yesterday`, or a count
/// and unit - `7d`, `7days`, `2w`, `3m` (months), `1y`, `24h` - where the count
/// defaults to 1 (`week`, `month`). Months are 30 days, years 365.
fn window_start(value: &str, now_ms: i64) -> Option<i64> {
    let v = value.to_ascii_lowercase();
    let today = || {
        let now = chrono::Local.timestamp_millis_opt(now_ms).single()?;
        local_midnight(now.date_naive())
    };
    match v.as_str() {
        "today" => return today(),
        "yesterday" => return today().map(|t| t - 86_400_000),
        _ => {}
    }
    let split = v.find(|c: char| !c.is_ascii_digit()).unwrap_or(v.len());
    let (count, unit) = v.split_at(split);
    let count: i64 = if count.is_empty() {
        1
    } else {
        count.parse().ok()?
    };
    let unit_ms: i64 = match unit {
        "h" | "hr" | "hrs" | "hour" | "hours" => 3_600_000,
        "d" | "day" | "days" => 86_400_000,
        "w" | "wk" | "week" | "weeks" => 7 * 86_400_000,
        "m" | "mo" | "month" | "months" => 30 * 86_400_000,
        "y" | "yr" | "year" | "years" => 365 * 86_400_000,
        _ => return None,
    };
    if count <= 0 {
        return None;
    }
    Some(now_ms - count.saturating_mul(unit_ms))
}

fn narrow_after(q: &mut ParsedQuery, ms: i64) {
    q.after_ms = Some(q.after_ms.map_or(ms, |a| a.max(ms)));
}

fn narrow_before(q: &mut ParsedQuery, ms: i64) {
    q.before_ms = Some(q.before_ms.map_or(ms, |b| b.min(ms)));
}

fn warn(
    q: &mut ParsedQuery,
    kind: &'static str,
    token: &str,
    suggestion: Option<String>,
    start: usize,
    end: usize,
) {
    q.warnings.push(QueryWarning {
        kind,
        token: token.to_string(),
        suggestion,
        start,
        end,
    });
}

fn chip(q: &mut ParsedQuery, kind: &'static str, value: &str, start: usize, end: usize) {
    q.chips.push(Chip {
        kind,
        value: value.to_string(),
        start,
        end,
    });
}

/// `from:` / `to:` / `label:` with a non-empty value (bare word or quoted).
fn apply_person_or_label(q: &mut ParsedQuery, key: &str, value: &str, start: usize, end: usize) {
    match key {
        "from" if value.eq_ignore_ascii_case("me") => {
            q.from_me = true;
            chip(q, "from", "me", start, end);
        }
        "from" => {
            q.from = Some(value.to_string());
            chip(q, "from", value, start, end);
        }
        "to" => {
            q.to = Some(value.to_string());
            chip(q, "to", value, start, end);
        }
        _ => {
            q.label.push(value.to_string());
            chip(q, "label", value, start, end);
        }
    }
}

pub fn parse(input: &str) -> ParsedQuery {
    parse_at(input, chrono::Utc::now().timestamp_millis())
}

/// `parse` with an explicit "now", so relative dates are testable.
pub fn parse_at(input: &str, now_ms: i64) -> ParsedQuery {
    let mut q = ParsedQuery::default();
    let mut fts_terms: Vec<String> = Vec::new();
    let mut text_terms: Vec<String> = Vec::new();
    let mut not_terms: Vec<String> = Vec::new();

    for Spanned { token, start, end } in tokenize(input) {
        let token = match token {
            Token::Phrase(Some(col), p) if matches!(col.as_str(), "from" | "to" | "label") => {
                let value = p.trim();
                if !value.is_empty() {
                    apply_person_or_label(&mut q, &col, value, start, end);
                }
                continue;
            }
            // Quoted phrase: exact (non-prefix) FTS phrase match, optionally
            // scoped to a column (`subject:"quarterly report"`).
            Token::Phrase(col, p) => {
                let words: Vec<String> = p
                    .split_whitespace()
                    .map(clean_token)
                    .filter(|w| !w.is_empty())
                    .collect();
                if !words.is_empty() {
                    let phrase = words.join(" ");
                    match col.as_deref() {
                        Some(c) => {
                            fts_terms.push(format!("{c}:\"{phrase}\""));
                            let kind = if c == "subject" { "subject" } else { "body" };
                            chip(&mut q, kind, &phrase, start, end);
                        }
                        None => {
                            fts_terms.push(format!("\"{phrase}\""));
                            // Sender-boost only applies to unscoped free text.
                            q.terms.push(fold(&phrase));
                            q.raw_terms.push(phrase.to_lowercase());
                        }
                    }
                    text_terms.push(phrase);
                }
                continue;
            }
            Token::Word(w) => w,
        };
        // Gmail-style negation: a token starting with '-' excludes the rest of
        // it (e.g. "-draft"). A bare "-" or "-:" cleans to nothing and is
        // dropped. Handled before operator parsing so "-from" is a text
        // exclusion, not a malformed operator.
        if let Some(rest) = token.strip_prefix('-') {
            let clean = clean_token(rest.trim_start_matches('-'));
            if !clean.is_empty() {
                not_terms.push(fts_term(&clean));
                chip(&mut q, "exclude", &clean, start, end);
            }
            continue;
        }
        // Operators are case-insensitive on both the key ("In:" == "in:") and
        // the value ("in:Sent" == "in:sent"); users type them however they like.
        let (key, value) = match token.split_once(':') {
            Some((k, v)) => (k.to_ascii_lowercase(), v),
            None => (String::new(), ""),
        };
        // Tolerate list punctuation around operator values:
        // `from:a@b.com, report` must not poison the address filter.
        let value = value.trim_matches([',', ';']);
        let lower = value.to_ascii_lowercase();
        match key.as_str() {
            // Address and label operators keep the value's original case
            // (matched case-insensitively downstream); a bare "from:" is a no-op.
            "from" | "to" | "label" => {
                if !value.is_empty() {
                    apply_person_or_label(&mut q, &key, value, start, end);
                }
            }
            "in" => match lower.as_str() {
                "" => {}
                "inbox" | "sent" | "drafts" | "trash" | "spam" => {
                    q.in_folder = Some(lower.clone());
                    chip(&mut q, "in", &lower, start, end);
                }
                "archive" | "done" => {
                    q.in_folder = Some("archive".into());
                    chip(&mut q, "in", "archive", start, end);
                }
                _ => {
                    let s = closest(&lower, IN_VALUES).map(|v| format!("in:{v}"));
                    warn(&mut q, "bad_value", &token, s, start, end);
                }
            },
            "is" => {
                match lower.as_str() {
                    "" => continue,
                    "unread" => q.is_unread = Some(true),
                    "read" => q.is_unread = Some(false),
                    "starred" => q.is_starred = Some(true),
                    "replied" => q.is_replied = true,
                    _ => {
                        let s = closest(&lower, IS_VALUES).map(|v| format!("is:{v}"));
                        warn(&mut q, "bad_value", &token, s, start, end);
                        continue;
                    }
                }
                chip(&mut q, "is", &lower, start, end);
            }
            "has" => {
                match lower.as_str() {
                    "" => continue,
                    "attachment" | "attachments" => q.has_attachment = Some(true),
                    "label" | "labels" => q.has_label = true,
                    _ => {
                        let s = closest(&lower, HAS_VALUES).map(|v| format!("has:{v}"));
                        warn(&mut q, "bad_value", &token, s, start, end);
                        continue;
                    }
                }
                let v = lower.trim_end_matches('s');
                chip(&mut q, "has", v, start, end);
            }
            // Column-scoped text: `subject:foo` / `body:foo` restrict the FTS
            // match to that column. A bare `subject:` / `body:` is a no-op.
            // Free-text (embedding) still sees the word; sender-boost does not.
            "subject" | "body" => {
                let clean = clean_token(value);
                if !clean.is_empty() {
                    fts_terms.push(fts_col_term(Some(key.as_str()), &clean));
                    let kind = if key == "subject" { "subject" } else { "body" };
                    chip(&mut q, kind, &clean, start, end);
                    text_terms.push(clean);
                }
            }
            // Exclude a term from results: "exclude:draft" drops any thread
            // whose messages match "draft". A bare "exclude:" is a no-op.
            "exclude" => {
                let clean = clean_token(value);
                if !clean.is_empty() {
                    not_terms.push(fts_term(&clean));
                    chip(&mut q, "exclude", &clean, start, end);
                }
            }
            // `after:` is inclusive of that day, `before:` exclusive (Gmail).
            "after" | "before" => {
                if value.is_empty() {
                    continue;
                }
                match parse_period(value) {
                    Some((from_ms, _)) => {
                        if key == "after" {
                            narrow_after(&mut q, from_ms);
                            chip(&mut q, "after", value, start, end);
                        } else {
                            narrow_before(&mut q, from_ms);
                            chip(&mut q, "before", value, start, end);
                        }
                    }
                    None => warn(&mut q, "bad_value", &token, None, start, end),
                }
            }
            // `between:A:B` (or `A..B`), both ends inclusive, either order.
            "between" => {
                if value.is_empty() {
                    continue;
                }
                let ends = value
                    .split_once("..")
                    .or_else(|| {
                        // Split on the ':' that separates two dates, not the
                        // '-'s inside them.
                        value.split_once(':')
                    })
                    .and_then(|(a, b)| Some((parse_period(a)?, parse_period(b)?)));
                match ends {
                    Some((a, b)) => {
                        let (lo, hi) = if a.0 <= b.0 { (a, b) } else { (b, a) };
                        narrow_after(&mut q, lo.0);
                        narrow_before(&mut q, hi.1);
                        chip(&mut q, "between", value, start, end);
                    }
                    None => warn(&mut q, "bad_value", &token, None, start, end),
                }
            }
            "last" | "newer_than" | "newer" | "within" => {
                if value.is_empty() {
                    continue;
                }
                match window_start(value, now_ms) {
                    Some(ms) => {
                        narrow_after(&mut q, ms);
                        chip(&mut q, "last", &lower, start, end);
                    }
                    None => {
                        let s = closest(&lower, LAST_VALUES).map(|v| format!("{key}:{v}"));
                        warn(&mut q, "bad_value", &token, s, start, end);
                    }
                }
            }
            "older_than" | "older" => {
                if value.is_empty() {
                    continue;
                }
                match window_start(value, now_ms) {
                    Some(ms) => {
                        narrow_before(&mut q, ms);
                        chip(&mut q, "older_than", &lower, start, end);
                    }
                    None => warn(&mut q, "bad_value", &token, None, start, end),
                }
            }
            "sort" | "order" => {
                let sort = match lower.as_str() {
                    "" => continue,
                    "newest" | "new" | "recent" | "latest" | "date" => Sort::Newest,
                    "oldest" | "old" | "earliest" => Sort::Oldest,
                    "relevance" | "relevant" | "best" => Sort::Relevance,
                    _ => {
                        let s = closest(&lower, SORT_VALUES).map(|v| format!("sort:{v}"));
                        warn(&mut q, "bad_value", &token, s, start, end);
                        continue;
                    }
                };
                q.sort = sort;
                let v = match sort {
                    Sort::Newest => "newest",
                    Sort::Oldest => "oldest",
                    Sort::Relevance => "relevance",
                };
                chip(&mut q, "sort", v, start, end);
            }
            // Not an operator (includes non-operator tokens with ':' like
            // "12:30"). A word-like key that is one typo away from a real
            // operator ("lable:work", "form:alice") is reported instead of
            // being searched as the meaningless word "lablework".
            _ => {
                let near = (key.chars().count() >= 3
                    && key.chars().all(|c| c.is_alphabetic() || c == '_'))
                .then(|| closest(&key, OPERATORS))
                .flatten();
                if let Some(op) = near {
                    let s = format!("{op}:{value}");
                    warn(&mut q, "unknown_operator", &token, Some(s), start, end);
                    continue;
                }
                let clean = clean_token(&token);
                if !clean.is_empty() {
                    fts_terms.push(fts_term(&clean));
                    q.terms.push(fold(&clean));
                    q.raw_terms.push(clean.to_lowercase());
                    text_terms.push(clean);
                }
            }
        }
    }

    // Explicit AND: FTS5 rejects implicit-AND juxtaposition of the
    // parenthesized groups fts_term() can produce.
    q.term_count = fts_terms.len();
    q.fts = fts_terms.join(" AND ");
    q.fts_or = fts_terms.join(" OR ");
    q.fts_not = not_terms.join(" OR ");
    q.text = text_terms.join(" ");
    q
}

/// Escape FTS special syntax by dropping everything but word-ish characters.
fn clean_token(token: &str) -> String {
    token
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '@' || *c == '.' || *c == '-' || *c == '_')
        .collect()
}

/// One FTS5 prefix term for a cleaned token. The index tokenizer
/// (unicode61 remove_diacritics 2) folds Vietnamese vowel diacritics but not
/// đ/Đ - a distinct letter, not a combining mark - so a leading unaccented
/// "d" also tries the "đ" variant ("don" matches both "dọn" and "đơn").
fn fts_term(clean: &str) -> String {
    fts_col_term(None, clean)
}

/// Like `fts_term`, but optionally constrained to a single FTS5 column
/// (`subject` / `body`) so `subject:foo` only matches the subject. FTS5 accepts
/// a column filter in front of a phrase or a parenthesized group.
fn fts_col_term(col: Option<&str>, clean: &str) -> String {
    let base = if let Some(rest) = clean.strip_prefix(['d', 'D']) {
        format!("(\"{clean}\"* OR \"đ{rest}\"*)")
    } else {
        format!("\"{clean}\"*")
    };
    match col {
        Some(c) => format!("{c}:{base}"),
        None => base,
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
    fn subject_and_body_scope_to_their_column() {
        let q = parse("subject:invoice body:overdue report");
        // Column-scoped terms carry an FTS5 column filter; free text does not.
        assert_eq!(
            q.fts,
            "subject:\"invoice\"* AND body:\"overdue\"* AND \"report\"*"
        );
        // "invoice"/"overdue" reach the embedding text but not sender-boost terms.
        assert!(q.text.contains("invoice") && q.text.contains("overdue"));
        assert_eq!(q.terms, vec!["report"]);
        // A bare operator is a no-op.
        assert!(parse("subject:").fts.is_empty());
    }

    #[test]
    fn subject_quoted_value_scopes_the_phrase() {
        let q = parse("subject:\"quarterly report\" budget");
        // The quoted value is an exact, column-scoped phrase; "budget" is free.
        assert_eq!(q.fts, "subject:\"quarterly report\" AND \"budget\"*");
        // Column-scoped phrases feed embedding text but not sender-boost.
        assert!(q.text.contains("quarterly report"));
        assert_eq!(q.terms, vec!["budget"]);
    }

    #[test]
    fn body_quoted_value_scopes_the_phrase() {
        let q = parse("body:\"past due\"");
        assert_eq!(q.fts, "body:\"past due\"");
    }

    #[test]
    fn case_marker_before_quote_still_scopes_the_phrase() {
        // `!`/`!!` right before the quote (documented as "ignore case" /
        // "match case exactly") must not break column scoping - previously
        // `body:!"..."` lost the "body" prefix entirely and fell through as
        // an unscoped, ungated positive term.
        let q = parse("body:!\"15.235.209.251\"");
        assert_eq!(q.fts, "body:\"15.235.209.251\"");

        let q = parse("subject:!!\"Exact Case\"");
        assert_eq!(q.fts, "subject:\"Exact Case\"");
    }

    #[test]
    fn subject_column_term_expands_dj_variant() {
        // d-initial values still get the đ variant, inside the column filter.
        let q = parse("subject:don");
        assert_eq!(q.fts, "subject:(\"don\"* OR \"đon\"*)");
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

    #[test]
    fn operator_value_tolerates_trailing_comma() {
        let q = parse("from:hoang.ngyen@nextwaves.com, software");
        assert_eq!(q.from.as_deref(), Some("hoang.ngyen@nextwaves.com"));
        assert_eq!(q.fts, "\"software\"*");
    }

    #[test]
    fn quoted_phrase_is_exact_match() {
        let q = parse("\"quarterly report\" budget");
        assert_eq!(q.fts, "\"quarterly report\" AND \"budget\"*");
        assert_eq!(q.text, "quarterly report budget");
        assert_eq!(q.terms, vec!["quarterly report", "budget"]);
    }

    #[test]
    fn unterminated_quote_is_still_a_phrase() {
        let q = parse("\"hello world");
        assert_eq!(q.fts, "\"hello world\"");
    }

    #[test]
    fn terms_are_folded_for_sender_matching() {
        let q = parse("Bé software");
        assert_eq!(q.terms, vec!["be", "software"]);
    }

    #[test]
    fn exclude_operator_collects_negated_terms() {
        // "draft" is d-initial, so it also gets the đ variant; "report" doesn't.
        let q = parse("report exclude:draft");
        assert_eq!(q.fts, "\"report\"*");
        assert_eq!(q.fts_not, "(\"draft\"* OR \"đraft\"*)");
        // Excluded terms must not leak into positive FTS, embedding text, or
        // the sender-boost terms.
        assert!(!q.text.contains("draft"));
        assert!(!q.terms.iter().any(|t| t.contains("draft")));
    }

    #[test]
    fn dash_prefix_is_exclusion() {
        let q = parse("report -draft -old");
        assert_eq!(q.fts, "\"report\"*");
        assert_eq!(q.fts_not, "(\"draft\"* OR \"đraft\"*) OR \"old\"*");
    }

    #[test]
    fn exclude_only_query_has_no_positive_fts() {
        let q = parse("-spam");
        assert!(q.fts.is_empty());
        assert_eq!(q.fts_not, "\"spam\"*");
    }

    #[test]
    fn bare_exclude_and_dash_are_noops() {
        let q = parse("hello exclude: -");
        assert_eq!(q.fts, "\"hello\"*");
        assert!(q.fts_not.is_empty());
    }

    #[test]
    fn exclude_preserves_value_case_like_positive_terms() {
        // The operator key is case-insensitive; the value keeps its case (FTS5
        // matches case-insensitively anyway). "Draft" is D-initial → đ variant.
        let q = parse("EXCLUDE:Draft");
        assert_eq!(q.fts_not, "(\"Draft\"* OR \"đraft\"*)");
    }

    // ---------- operators added for the search overhaul ----------

    /// A fixed "now" (2026-06-15 12:00 UTC) so relative dates are stable.
    const NOW: i64 = 1_781_524_800_000;
    const DAY: i64 = 86_400_000;

    fn midnight(y: i32, m: u32, d: u32) -> i64 {
        local_midnight(NaiveDate::from_ymd_opt(y, m, d).unwrap()).unwrap()
    }

    fn kinds(q: &ParsedQuery) -> Vec<&'static str> {
        q.chips.iter().map(|c| c.kind).collect()
    }

    #[test]
    fn label_operator_bare_and_quoted() {
        let q = parse("label:Work label:\"Follow up\" invoice");
        assert_eq!(q.label, vec!["Work", "Follow up"]);
        assert_eq!(q.fts, "\"invoice\"*", "label values never reach FTS");
        assert_eq!(kinds(&q), vec!["label", "label"]);
        assert_eq!(q.chips[1].value, "Follow up");
    }

    #[test]
    fn half_typed_operators_are_silent_noops() {
        // While typing, a bare operator must not change results or warn.
        let q = parse("label: from: to: in: is: has: last: after: sort: subject:");
        assert!(q.fts.is_empty());
        assert!(q.chips.is_empty(), "{:?}", q.chips);
        assert!(q.warnings.is_empty(), "{:?}", q.warnings);
        assert!(q.label.is_empty() && q.from.is_none() && q.after_ms.is_none());
    }

    #[test]
    fn after_before_between_dates() {
        let q = parse_at("after:2026-01-15", NOW);
        assert_eq!(q.after_ms, Some(midnight(2026, 1, 15)));
        assert_eq!(kinds(&q), vec!["after"]);

        // before: is exclusive of that day (Gmail semantics).
        let q = parse_at("before:2026/03/01", NOW);
        assert_eq!(q.before_ms, Some(midnight(2026, 3, 1)));

        // between: includes both ends, in either order.
        let q = parse_at("between:2026-03-31:2026-01-01", NOW);
        assert_eq!(q.after_ms, Some(midnight(2026, 1, 1)));
        assert_eq!(q.before_ms, Some(midnight(2026, 4, 1)));
        let q = parse_at("between:2026-01..2026-02", NOW);
        assert_eq!(q.after_ms, Some(midnight(2026, 1, 1)));
        assert_eq!(q.before_ms, Some(midnight(2026, 3, 1)));

        // Whole year; December month rolls over.
        let q = parse_at("between:2025:2025-12", NOW);
        assert_eq!(q.after_ms, Some(midnight(2025, 1, 1)));
        assert_eq!(q.before_ms, Some(midnight(2026, 1, 1)));

        // Several bounds narrow, never widen.
        let q = parse_at(
            "after:2026-01-01 after:2026-02-01 before:2026-05-01 before:2026-04-01",
            NOW,
        );
        assert_eq!(q.after_ms, Some(midnight(2026, 2, 1)));
        assert_eq!(q.before_ms, Some(midnight(2026, 4, 1)));
    }

    #[test]
    fn bad_dates_warn_and_never_leak_into_fts() {
        for input in [
            "after:2026-13-01",
            "before:tomorrowish",
            "between:2026-01-01",
        ] {
            let q = parse_at(input, NOW);
            assert!(q.fts.is_empty(), "{input}: {}", q.fts);
            assert!(q.after_ms.is_none() && q.before_ms.is_none(), "{input}");
            assert_eq!(q.warnings.len(), 1, "{input}");
            assert_eq!(q.warnings[0].kind, "bad_value");
        }
    }

    #[test]
    fn last_and_older_than_windows() {
        let cases = [
            ("last:7d", 7 * DAY),
            ("last:7days", 7 * DAY),
            ("last:week", 7 * DAY),
            ("LAST:2W", 14 * DAY),
            ("last:month", 30 * DAY),
            ("last:3m", 90 * DAY),
            ("last:1y", 365 * DAY),
            ("last:24h", DAY),
            ("newer_than:2d", 2 * DAY),
            ("within:10days", 10 * DAY),
        ];
        for (input, span) in cases {
            let q = parse_at(input, NOW);
            assert_eq!(q.after_ms, Some(NOW - span), "{input}");
            assert_eq!(kinds(&q), vec!["last"], "{input}");
        }
        let q = parse_at("last:today", NOW);
        let today = chrono::Local
            .timestamp_millis_opt(NOW)
            .unwrap()
            .date_naive();
        assert_eq!(q.after_ms, local_midnight(today));

        let q = parse_at("older_than:1y", NOW);
        assert_eq!(q.before_ms, Some(NOW - 365 * DAY));
        assert!(q.after_ms.is_none());

        // A typo suggests the closest value; nonsense just warns.
        let q = parse_at("last:wek", NOW);
        assert_eq!(q.warnings[0].suggestion.as_deref(), Some("last:week"));
        let q = parse_at("last:0d", NOW);
        assert_eq!(q.warnings[0].kind, "bad_value");
        assert!(q.after_ms.is_none());
    }

    #[test]
    fn sort_operator() {
        assert_eq!(parse("sort:oldest").sort, Sort::Oldest);
        assert_eq!(parse("sort:Newest").sort, Sort::Newest);
        assert_eq!(parse("sort:recent").sort, Sort::Newest);
        assert_eq!(parse("sort:best").sort, Sort::Relevance);
        assert_eq!(parse("x").sort, Sort::Relevance);
        let q = parse("sort:olest");
        assert_eq!(q.sort, Sort::Relevance);
        assert_eq!(q.warnings[0].suggestion.as_deref(), Some("sort:oldest"));
        assert!(q.fts.is_empty());
    }

    #[test]
    fn from_me_read_replied_has_label() {
        let q = parse("from:me is:read is:replied has:label");
        assert!(q.from_me);
        assert!(q.from.is_none(), "from:me is not an address filter");
        assert_eq!(q.is_unread, Some(false));
        assert!(q.is_replied);
        assert!(q.has_label);
        assert_eq!(kinds(&q), vec!["from", "is", "is", "has"]);
        // `from:"Alice Smith"` takes a quoted name.
        assert_eq!(
            parse("from:\"Alice Smith\"").from.as_deref(),
            Some("Alice Smith")
        );
    }

    #[test]
    fn bad_values_suggest_the_closest_valid_one() {
        let cases = [
            ("in:inbx", "in:inbox"),
            ("is:unred", "is:unread"),
            ("is:star", "is:starred"),
            ("has:attachmnt", "has:attachment"),
        ];
        for (input, want) in cases {
            let q = parse(input);
            assert!(q.fts.is_empty(), "{input} leaked into FTS");
            assert_eq!(q.warnings.len(), 1, "{input}");
            assert_eq!(q.warnings[0].kind, "bad_value");
            assert_eq!(q.warnings[0].suggestion.as_deref(), Some(want), "{input}");
        }
    }

    #[test]
    fn misspelt_operators_warn_instead_of_searching_junk() {
        let q = parse("lable:work report");
        assert_eq!(q.fts, "\"report\"*", "must not search for 'lablework'");
        assert_eq!(q.warnings[0].kind, "unknown_operator");
        assert_eq!(q.warnings[0].suggestion.as_deref(), Some("label:work"));
        assert_eq!(
            parse("form:alice").warnings[0].suggestion.as_deref(),
            Some("from:alice")
        );
        assert_eq!(
            parse("subjct:invoice").warnings[0].suggestion.as_deref(),
            Some("subject:invoice")
        );
        // Not near any operator: still plain text, no warning.
        for input in ["re:meeting", "todo:x", "12:30", "https://example.com"] {
            let q = parse(input);
            assert!(q.warnings.is_empty(), "{input}: {:?}", q.warnings);
            assert!(!q.fts.is_empty(), "{input}");
        }
    }

    #[test]
    fn spans_are_utf16_offsets_covering_the_whole_operator() {
        let input = "😀 from:alice label:\"Follow up\" -spam";
        let q = parse(input);
        let utf16: Vec<u16> = input.encode_utf16().collect();
        let text = |start: usize, end: usize| String::from_utf16(&utf16[start..end]).unwrap();
        let spans: Vec<String> = q.chips.iter().map(|c| text(c.start, c.end)).collect();
        assert_eq!(spans, vec!["from:alice", "label:\"Follow up\"", "-spam"]);

        let q = parse("hùng lable:x");
        let w = &q.warnings[0];
        let utf16: Vec<u16> = "hùng lable:x".encode_utf16().collect();
        assert_eq!(
            String::from_utf16(&utf16[w.start..w.end]).unwrap(),
            "lable:x"
        );
    }

    #[test]
    fn term_count_and_explain() {
        let q = parse("quarterly report subject:q1 from:alice -draft");
        assert_eq!(q.term_count, 3);
        let e = q.explain();
        assert_eq!(e.terms, vec!["quarterly", "report"]);
        assert_eq!(
            e.chips.iter().map(|c| c.kind).collect::<Vec<_>>(),
            vec!["subject", "from", "exclude"]
        );
        // Operator-only: no free-text terms at all.
        let q = parse("from:alice is:unread");
        assert_eq!(q.term_count, 0);
        assert!(q.explain().terms.is_empty());
    }

    #[test]
    fn vietnamese_and_ids_stay_searchable_alongside_operators() {
        let q = parse("báo giá label:work SAL-QTN-2026-00371");
        assert_eq!(q.terms, vec!["bao", "gia", "sal-qtn-2026-00371"]);
        assert_eq!(q.raw_terms, vec!["báo", "giá", "sal-qtn-2026-00371"]);
        assert_eq!(q.label, vec!["work"]);
        assert_eq!(q.term_count, 3);
    }
}
