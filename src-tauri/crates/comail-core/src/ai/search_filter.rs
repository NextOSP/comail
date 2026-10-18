//! Natural language → search query ("all email from hoang about software
//! update" → `from:hoang.nguyen@nextwaves.com subject:"software update"`).
//! Grounded in the user's contacts so names resolve to real addresses; when a
//! name fits several people (or the request is too vague) the model asks one
//! short question with pickable options instead of guessing.

use super::{AiConfig, ChatMessage, chat_structured, parse_json};
use crate::error::{CoreError, Result};
use crate::models::ContactSuggestion;
use serde::{Deserialize, Serialize};
use serde_json::json;

/// One earlier clarification round: the model's question and what the user
/// picked or typed.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterTurn {
    pub question: String,
    pub answer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilterOption {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SearchFilter {
    /// A ready search-box query.
    Query { query: String },
    /// A clarifying question; the UI shows `options` as choices (plus free text).
    Ask {
        question: String,
        options: Vec<FilterOption>,
    },
}

#[derive(Deserialize)]
struct Raw {
    kind: String,
    #[serde(default)]
    query: String,
    #[serde(default)]
    question: String,
    #[serde(default)]
    options: Vec<FilterOption>,
}

const MAX_OPTIONS: usize = 6;

/// Words of the request worth looking up as contact names.
pub fn name_candidates(request: &str) -> Vec<String> {
    const STOP: &[&str] = &[
        "all",
        "any",
        "email",
        "emails",
        "mail",
        "mails",
        "message",
        "messages",
        "from",
        "to",
        "with",
        "have",
        "has",
        "the",
        "and",
        "about",
        "subject",
        "that",
        "this",
        "last",
        "week",
        "month",
        "year",
        "today",
        "unread",
        "starred",
        "attachment",
        "attachments",
        "sent",
        "show",
        "find",
        "me",
        "my",
        "for",
        "in",
        "on",
        "of",
    ];
    let mut out: Vec<String> = Vec::new();
    // Drop quoted spans: those are subject/body phrases, not people.
    let mut unquoted = String::new();
    for (i, part) in request.split('"').enumerate() {
        if i % 2 == 0 {
            unquoted.push_str(part);
            unquoted.push(' ');
        }
    }
    for w in unquoted.split(|c: char| c.is_whitespace() || ",;:()".contains(c)) {
        let w = w.trim_matches(|c: char| !c.is_alphanumeric() && c != '@' && c != '.');
        if w.chars().count() < 2 || STOP.contains(&w.to_lowercase().as_str()) {
            continue;
        }
        if !out.iter().any(|o| o.eq_ignore_ascii_case(w)) {
            out.push(w.to_string());
        }
    }
    out.truncate(8);
    out
}

fn prompt(
    request: &str,
    history: &[FilterTurn],
    contacts: &[ContactSuggestion],
    self_emails: &[String],
    today: &str,
) -> Vec<ChatMessage> {
    let contact_lines = if contacts.is_empty() {
        "(none matched)".to_string()
    } else {
        contacts
            .iter()
            .map(
                |c| match c.name.as_deref().filter(|n| !n.trim().is_empty()) {
                    Some(n) => format!("- {n} <{}> ({} emails)", c.email, c.interactions),
                    None => format!("- {} ({} emails)", c.email, c.interactions),
                },
            )
            .collect::<Vec<_>>()
            .join("\n")
    };
    let system = format!(
        "You turn a natural-language description of emails into ONE search query for an email client.\n\
         Today is {today}. The user's own addresses: {selves}.\n\
         Operators (combine with spaces; quote multi-word values):\n\
         - from:ADDRESS (at most one; from:me = mail the user sent)\n\
         - to:ADDRESS (at most one)\n\
         - subject:\"words\"   body:\"words\"   label:NAME\n\
         - in:inbox|sent|drafts|archive|trash|spam\n\
         - is:unread|read|starred|replied   has:attachment\n\
         - last:7d|2w|3m|1y|today|yesterday   older_than:1y\n\
         - after:YYYY-MM-DD   before:YYYY-MM-DD   between:YYYY-MM-DD:YYYY-MM-DD\n\
         - sort:newest|oldest   -word excludes a word\n\
         - plain words / \"phrases\" match anywhere\n\
         Contacts matching words in the request (name <email> (emails exchanged)):\n{contact_lines}\n\
         Rules:\n\
         - Use a person's full email address from the contacts list for from:/to:.\n\
         - If a name clearly matches exactly one contact, use it. If it matches several \
           different people and none clearly dominates, ASK which one: options are those \
           contacts (label = \"Name <email>\", value = the email), most emailed first.\n\
         - If a name matches no contact, use the name itself as the value (from:hoang).\n\
         - Ask only when the answer would change the query a lot; otherwise decide. \
           Never ask the same question twice; the user's earlier answers are final.\n\
         - Asking: kind=\"ask\", a short question in the user's language, 2-{MAX_OPTIONS} options \
           (value = text to apply), query=\"\".\n\
         - Answering: kind=\"query\", question=\"\", options=[].\n\
         - The request may be in any language; operators stay in English, keep subject/body \
           words as the user wrote them.\n\
         Reply with ONLY the JSON object.",
        selves = if self_emails.is_empty() {
            "(unknown)".to_string()
        } else {
            self_emails.join(", ")
        },
    );
    let mut user = format!("Request: {request}");
    for t in history {
        user.push_str(&format!(
            "\nYou asked: {}\nUser answered: {}",
            t.question, t.answer
        ));
    }
    vec![
        ChatMessage {
            role: "system",
            content: system,
        },
        ChatMessage {
            role: "user",
            content: user,
        },
    ]
}

fn schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "kind": { "type": "string", "enum": ["query", "ask"] },
            "query": { "type": "string" },
            "question": { "type": "string" },
            "options": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": { "type": "string" },
                        "value": { "type": "string" }
                    },
                    "required": ["label", "value"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["kind", "query", "question", "options"],
        "additionalProperties": false
    })
}

fn interpret(raw: Raw, history_len: usize) -> Result<SearchFilter> {
    let mut options: Vec<FilterOption> = raw
        .options
        .into_iter()
        .filter(|o| !o.value.trim().is_empty())
        .map(|o| FilterOption {
            label: if o.label.trim().is_empty() {
                o.value.clone()
            } else {
                o.label
            },
            value: o.value,
        })
        .collect();
    options.truncate(MAX_OPTIONS);
    let query = raw.query.trim().to_string();
    // Cap the back-and-forth: after a few rounds, take the query as-is.
    let may_ask = history_len < 3;
    if raw.kind == "ask" && may_ask && !raw.question.trim().is_empty() {
        return Ok(SearchFilter::Ask {
            question: raw.question.trim().to_string(),
            options,
        });
    }
    if query.is_empty() {
        return Err(CoreError::Other("ai returned no search query".into()));
    }
    Ok(SearchFilter::Query { query })
}

pub async fn search_filter(
    cfg: &AiConfig,
    request: &str,
    history: &[FilterTurn],
    contacts: &[ContactSuggestion],
    self_emails: &[String],
) -> Result<SearchFilter> {
    let today = chrono::Local::now().format("%Y-%m-%d (%A)").to_string();
    let out = chat_structured(
        cfg,
        prompt(request, history, contacts, self_emails, &today),
        "search_filter",
        schema(),
    )
    .await?;
    let raw: Raw = parse_json(&out)
        .ok_or_else(|| CoreError::Other(format!("unparseable ai search filter: {out}")))?;
    interpret(raw, history.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_skip_quoted_phrases_and_filler() {
        let c = name_candidates(r#"all email from hoang have subject "software update""#);
        assert_eq!(c, vec!["hoang"]);
    }

    #[test]
    fn ask_turns_into_query_after_enough_rounds() {
        let raw = || Raw {
            kind: "ask".into(),
            query: "from:hoang".into(),
            question: "Which Hoang?".into(),
            options: vec![FilterOption {
                label: "Hoang <h@x.com>".into(),
                value: "h@x.com".into(),
            }],
        };
        assert!(matches!(
            interpret(raw(), 0).unwrap(),
            SearchFilter::Ask { .. }
        ));
        assert_eq!(
            interpret(raw(), 3).unwrap(),
            SearchFilter::Query {
                query: "from:hoang".into()
            }
        );
    }

    #[test]
    fn empty_query_is_an_error() {
        let raw = Raw {
            kind: "query".into(),
            query: "  ".into(),
            question: String::new(),
            options: vec![],
        };
        assert!(interpret(raw, 0).is_err());
    }
}
