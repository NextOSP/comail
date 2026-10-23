//! MCP tool catalogue and handlers. Every handler is a thin shim over a `Core`
//! method; results are compact JSON text so they stay cheap in a model's
//! context. Write tools are gated by the user's permission settings, checked
//! both when listing and again on every call.

use serde_json::{Value, json};

use crate::Core;
use crate::db::repo;
use crate::models::{
    ActionKind, ActionParams, Address, MessageDetail, PerformActionArgs, QueueSendArgs,
    SaveDraftArgs, Settings, ThreadSummary, View,
};

pub(super) const UNKNOWN_TOOL: &str = "unknown tool";

/// Body text returned per message; long newsletters are cut here.
const BODY_LIMIT: usize = 20_000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Group {
    Read,
    Draft,
    Send,
    Actions,
}

struct ToolDef {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    group: Group,
    destructive: bool,
    schema: Value,
}

fn allowed(group: Group, s: &Settings) -> bool {
    match group {
        Group::Read => true,
        Group::Draft => s.mcp_allow_drafts,
        Group::Send => s.mcp_allow_send,
        Group::Actions => s.mcp_allow_actions,
    }
}

/// Irreversible deletion needs its own opt-in on top of the general actions gate.
fn permanent_delete_allowed(s: &Settings) -> bool {
    s.mcp_allow_actions && s.mcp_allow_permanent_delete
}

fn defs() -> Vec<ToolDef> {
    let account_id = json!({ "type": "integer", "description": "Limit to one account (see list_accounts). Omit for all accounts." });
    vec![
        ToolDef {
            name: "list_accounts",
            title: "List email accounts",
            description: "List the email accounts configured in comail (id, address, provider).",
            group: Group::Read,
            destructive: false,
            schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDef {
            name: "search_emails",
            title: "Search emails",
            description: "Search the mailbox (keyword + semantic). Returns matching threads, best \
                first. Supports operators mixed with keywords: from:alice, from:me, to:bob, \
                subject:invoice, label:work, is:unread, is:starred, has:attachment, last:7d, \
                after:2026-01-31, before:2026-03-01, older_than:1y, -word to exclude.",
            group: Group::Read,
            destructive: false,
            schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Keywords and/or operators, e.g. \"from:alice budget is:unread\"." },
                    "account_id": account_id,
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "description": "Max threads (default 20)." }
                },
                "required": ["query"]
            }),
        },
        ToolDef {
            name: "list_threads",
            title: "List threads in a view",
            description: "List threads in a mailbox view, newest first. Page with next_cursor.",
            group: Group::Read,
            destructive: false,
            schema: json!({
                "type": "object",
                "properties": {
                    "view": { "type": "string", "enum": ["inbox", "starred", "snoozed", "sent", "drafts", "done", "trash", "spam", "all"], "description": "Default inbox." },
                    "tab": { "type": "string", "enum": ["important", "other"], "description": "Inbox split tab. Omit for the whole inbox." },
                    "label_id": { "type": "integer", "description": "Only threads with this label (see list_labels)." },
                    "account_id": account_id,
                    "cursor": { "type": "integer", "description": "next_cursor from a previous page." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Default 25." }
                }
            }),
        },
        ToolDef {
            name: "get_thread",
            title: "Read a thread",
            description: "Read every message in a thread with plain-text bodies. Bodies not yet \
                downloaded are fetched in the background; call again shortly if body_pending is true.",
            group: Group::Read,
            destructive: false,
            schema: json!({
                "type": "object",
                "properties": { "thread_id": { "type": "integer" } },
                "required": ["thread_id"]
            }),
        },
        ToolDef {
            name: "get_message",
            title: "Read a message",
            description: "Read one message (headers, plain-text body, attachment list).",
            group: Group::Read,
            destructive: false,
            schema: json!({
                "type": "object",
                "properties": { "message_id": { "type": "integer" } },
                "required": ["message_id"]
            }),
        },
        ToolDef {
            name: "list_labels",
            title: "List labels",
            description: "List the user's labels (id, name).",
            group: Group::Read,
            destructive: false,
            schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDef {
            name: "list_folders",
            title: "List folders",
            description: "List IMAP folders (id, name, role) for moving mail.",
            group: Group::Read,
            destructive: false,
            schema: json!({ "type": "object", "properties": { "account_id": account_id } }),
        },
        ToolDef {
            name: "search_contacts",
            title: "Find contacts",
            description: "Find contacts by name or address, ranked by how often the user emails them.",
            group: Group::Read,
            destructive: false,
            schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20 }
                },
                "required": ["query"]
            }),
        },
        ToolDef {
            name: "unread_counts",
            title: "Unread counts",
            description: "Unread counts for the inbox and its tabs.",
            group: Group::Read,
            destructive: false,
            schema: json!({ "type": "object", "properties": { "account_id": account_id } }),
        },
        ToolDef {
            name: "inbox_brief",
            title: "Inbox brief",
            description: "A short plain-text brief of what's new in the Important inbox.",
            group: Group::Read,
            destructive: false,
            schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDef {
            name: "latest_verification_code",
            title: "Latest verification code",
            description: "The most recent one-time sign-in / verification code received by email.",
            group: Group::Read,
            destructive: false,
            schema: json!({
                "type": "object",
                "properties": { "max_age_minutes": { "type": "integer", "description": "Default 15." } }
            }),
        },
        ToolDef {
            name: "list_events",
            title: "List calendar events",
            description: "Calendar events between two dates (ISO 8601). Defaults to the next 7 days.",
            group: Group::Read,
            destructive: false,
            schema: json!({
                "type": "object",
                "properties": {
                    "start": { "type": "string", "description": "e.g. 2026-10-20 or 2026-10-20T09:00:00Z" },
                    "end": { "type": "string" }
                }
            }),
        },
        ToolDef {
            name: "create_draft",
            title: "Create a draft",
            description: "Save a new email as a draft in comail for the user to review. Does not send.",
            group: Group::Draft,
            destructive: false,
            schema: json!({
                "type": "object",
                "properties": {
                    "to": { "type": "array", "items": { "type": "string" }, "description": "Addresses, \"a@b.com\" or \"Name <a@b.com>\"." },
                    "cc": { "type": "array", "items": { "type": "string" } },
                    "bcc": { "type": "array", "items": { "type": "string" } },
                    "subject": { "type": "string" },
                    "body": { "type": "string", "description": "Plain text body." },
                    "account_id": { "type": "integer", "description": "Account to send from. Defaults to the first account." }
                },
                "required": ["to", "subject", "body"]
            }),
        },
        ToolDef {
            name: "create_reply_draft",
            title: "Draft a reply",
            description: "Save a reply to a message as a draft (recipients, subject and quoting are \
                filled in). Does not send.",
            group: Group::Draft,
            destructive: false,
            schema: json!({
                "type": "object",
                "properties": {
                    "message_id": { "type": "integer", "description": "The message being replied to." },
                    "body": { "type": "string", "description": "Plain text reply (the original is quoted below it)." },
                    "reply_all": { "type": "boolean", "description": "Also reply to the other recipients. Default false." }
                },
                "required": ["message_id", "body"]
            }),
        },
        ToolDef {
            name: "update_draft",
            title: "Update a draft",
            description: "Change fields of an existing draft. Omitted fields are kept.",
            group: Group::Draft,
            destructive: false,
            schema: json!({
                "type": "object",
                "properties": {
                    "draft_id": { "type": "integer" },
                    "to": { "type": "array", "items": { "type": "string" } },
                    "cc": { "type": "array", "items": { "type": "string" } },
                    "bcc": { "type": "array", "items": { "type": "string" } },
                    "subject": { "type": "string" },
                    "body": { "type": "string" }
                },
                "required": ["draft_id"]
            }),
        },
        ToolDef {
            name: "delete_draft",
            title: "Delete a draft",
            description: "Delete a draft.",
            group: Group::Draft,
            destructive: true,
            schema: json!({
                "type": "object",
                "properties": { "draft_id": { "type": "integer" } },
                "required": ["draft_id"]
            }),
        },
        ToolDef {
            name: "send_draft",
            title: "Send a draft",
            description: "Send a saved draft. It goes out after the user's undo-send delay and can \
                still be cancelled in comail until then. Only send when the user explicitly asked.",
            group: Group::Send,
            destructive: true,
            schema: json!({
                "type": "object",
                "properties": { "draft_id": { "type": "integer" } },
                "required": ["draft_id"]
            }),
        },
        ToolDef {
            name: "deletion_status",
            title: "Check permanent deletion",
            description: "Check queued permanent-deletion action IDs. done means remote deletion and local cleanup completed; pending/inflight are not success. failed includes the reason.",
            group: Group::Read,
            destructive: false,
            schema: json!({ "type": "object", "properties": {
                "action_ids": { "type": "array", "items": { "type": "integer" }, "maxItems": 1000 }
            }, "required": ["action_ids"] }),
        },
        ToolDef {
            name: "modify_threads",
            title: "Organize threads",
            description: "Apply an action to threads: archive, unarchive, mark_read, mark_unread, \
                star, unstar, trash, spam, not_spam, move (folder_id), snooze (snooze_until), \
                unsnooze, add_label / remove_label (label_id). delete_permanently irreversibly deletes only messages currently in Trash, preserving other messages in the thread. Needs a separate permanent-deletion permission in comail Settings; only use when the user explicitly requests permanent deletion. Returns queued action_ids; poll deletion_status for remote completion.",
            group: Group::Actions,
            destructive: true,
            schema: json!({
                "type": "object",
                "properties": {
                    "thread_ids": { "type": "array", "items": { "type": "integer" } },
                    "action": { "type": "string", "enum": ["archive", "unarchive", "mark_read", "mark_unread", "star", "unstar", "trash", "delete_permanently", "spam", "not_spam", "move", "snooze", "unsnooze", "add_label", "remove_label"] },
                    "label_id": { "type": "integer" },
                    "folder_id": { "type": "integer" },
                    "snooze_until": { "type": "string", "description": "ISO 8601 time to wake the thread." }
                },
                "required": ["thread_ids", "action"]
            }),
        },
    ]
}

/// The `tools/list` payload for the current permissions.
pub(super) fn list(settings: &Settings) -> Vec<Value> {
    defs()
        .into_iter()
        .filter(|d| allowed(d.group, settings))
        .map(|d| {
            let read_only = d.group == Group::Read;
            json!({
                "name": d.name,
                "title": d.title,
                "description": d.description,
                "inputSchema": d.schema,
                "annotations": {
                    "title": d.title,
                    "readOnlyHint": read_only,
                    "destructiveHint": d.destructive,
                    "openWorldHint": d.group == Group::Send,
                },
            })
        })
        .collect()
}

type ToolResult = std::result::Result<String, String>;

pub(super) async fn call(core: &Core, name: &str, args: Value) -> ToolResult {
    let Some(def) = defs().into_iter().find(|d| d.name == name) else {
        return Err(format!("{UNKNOWN_TOOL}: {name}"));
    };
    let settings = core.get_settings().await?;
    if !allowed(def.group, &settings) {
        return Err(format!(
            "{name} is turned off. The user can allow it in comail Settings > AI clients (MCP)."
        ));
    }
    if name == "modify_threads"
        && args["action"].as_str() == Some("delete_permanently")
        && !permanent_delete_allowed(&settings)
    {
        return Err(
            "delete_permanently is turned off. The user can allow it separately in comail Settings > AI clients (MCP)."
                .into(),
        );
    }
    let out = match name {
        "list_accounts" => json!(core.list_accounts().await?),
        "search_emails" => {
            let query = str_arg(&args, "query")?;
            let limit = args["limit"].as_i64().unwrap_or(20).clamp(1, 50);
            let res = core
                .search(query, opt_i64(&args, "account_id"), limit)
                .await?;
            json!({ "threads": res.threads.iter().map(thread_json).collect::<Vec<_>>() })
        }
        "list_threads" => {
            let view: View = match args["view"].as_str() {
                Some(v) => {
                    serde_json::from_value(json!(v)).map_err(|_| format!("unknown view: {v}"))?
                }
                None => View::Inbox,
            };
            let split = match args["tab"].as_str() {
                Some("important") => Some(-1),
                Some("other") => Some(-2),
                _ => None,
            };
            let page = core
                .list_threads(
                    view,
                    split,
                    opt_i64(&args, "account_id"),
                    opt_i64(&args, "label_id"),
                    None,
                    opt_i64(&args, "cursor"),
                    args["limit"].as_i64().unwrap_or(25).clamp(1, 100),
                )
                .await?;
            json!({
                "threads": page.threads.iter().map(thread_json).collect::<Vec<_>>(),
                "next_cursor": page.next_cursor,
            })
        }
        "get_thread" => {
            let thread_id = i64_arg(&args, "thread_id")?;
            let (thread, messages) = core
                .db
                .read(move |conn| {
                    let thread = repo::threads::get_summary(conn, thread_id)?.ok_or_else(|| {
                        crate::error::CoreError::NotFound(format!("thread {thread_id}"))
                    })?;
                    Ok((thread, repo::messages::list_for_thread(conn, thread_id)?))
                })
                .await?;
            for m in &messages {
                if m.body_state == "none" || m.body_state == "fetching" {
                    core.request_body(m.account_id, m.id).await;
                }
            }
            json!({
                "thread": thread_json(&thread),
                "messages": messages.iter().map(message_json).collect::<Vec<_>>(),
            })
        }
        "get_message" => {
            let id = i64_arg(&args, "message_id")?;
            let m = core
                .db
                .read(move |conn| repo::messages::detail(conn, id))
                .await?;
            if m.body_state == "none" || m.body_state == "fetching" {
                core.request_body(m.account_id, m.id).await;
            }
            message_json(&m)
        }
        "list_labels" => json!(
            core.list_labels()
                .await?
                .into_iter()
                .map(|l| json!({ "id": l.id, "name": l.name, "auto": l.is_auto }))
                .collect::<Vec<_>>()
        ),
        "list_folders" => json!(core.list_folders(opt_i64(&args, "account_id")).await?),
        "search_contacts" => {
            let query = str_arg(&args, "query")?;
            let limit = args["limit"].as_i64().unwrap_or(10);
            json!(core.suggest_contacts(query, limit).await?)
        }
        "unread_counts" => json!(core.unread_counts(opt_i64(&args, "account_id")).await?),
        "inbox_brief" => json!(core.inbox_brief().await?),
        "latest_verification_code" => {
            let age = args["max_age_minutes"]
                .as_i64()
                .unwrap_or(15)
                .clamp(1, 24 * 60);
            json!(core.latest_verification_code(age).await?)
        }
        "list_events" => {
            let now = crate::models::now_ms();
            let start = match args["start"].as_str() {
                Some(s) => parse_time(s)?,
                None => now,
            };
            let end = match args["end"].as_str() {
                Some(s) => parse_time(s)?,
                None => start + 7 * 86_400_000,
            };
            json!(core.list_events(start, end).await?)
        }
        "create_draft" => {
            let account_id = match opt_i64(&args, "account_id") {
                Some(id) => id,
                None => core
                    .list_accounts()
                    .await?
                    .first()
                    .map(|a| a.id)
                    .ok_or("no email account is set up in comail")?,
            };
            let draft_id = core
                .save_draft(SaveDraftArgs {
                    draft_id: None,
                    account_id,
                    to: addrs_arg(&args, "to")?,
                    cc: addrs_arg(&args, "cc")?,
                    bcc: addrs_arg(&args, "bcc")?,
                    subject: str_arg(&args, "subject")?,
                    body_text: str_arg(&args, "body")?,
                    body_html: None,
                    mode: "new".into(),
                    in_reply_to_message_id: None,
                    attachments: Vec::new(),
                })
                .await?;
            json!({ "draft_id": draft_id, "status": "saved to Drafts in comail (not sent)" })
        }
        "create_reply_draft" => {
            let message_id = i64_arg(&args, "message_id")?;
            let reply_all = args["reply_all"].as_bool().unwrap_or(false);
            let body = str_arg(&args, "body")?;
            let original = core
                .db
                .read(move |conn| repo::messages::detail(conn, message_id))
                .await?;
            let own: Vec<String> = core
                .list_accounts()
                .await?
                .into_iter()
                .map(|a| a.email.to_lowercase())
                .collect();
            let draft = reply_draft(&original, &body, reply_all, &own);
            let draft_id = core.save_draft(draft).await?;
            json!({ "draft_id": draft_id, "status": "reply saved to Drafts in comail (not sent)" })
        }
        "update_draft" => {
            let draft_id = i64_arg(&args, "draft_id")?;
            let mut draft = core.get_draft(draft_id).await?;
            draft.draft_id = Some(draft_id);
            if args.get("to").is_some() {
                draft.to = addrs_arg(&args, "to")?;
            }
            if args.get("cc").is_some() {
                draft.cc = addrs_arg(&args, "cc")?;
            }
            if args.get("bcc").is_some() {
                draft.bcc = addrs_arg(&args, "bcc")?;
            }
            if let Some(s) = args["subject"].as_str() {
                draft.subject = s.to_string();
            }
            if let Some(b) = args["body"].as_str() {
                draft.body_text = b.to_string();
                // The old rich body no longer matches the new text.
                draft.body_html = None;
            }
            core.save_draft(draft).await?;
            json!({ "draft_id": draft_id, "status": "updated" })
        }
        "delete_draft" => {
            core.delete_draft(i64_arg(&args, "draft_id")?).await?;
            json!({ "status": "deleted" })
        }
        "send_draft" => {
            let draft_id = i64_arg(&args, "draft_id")?;
            // queue_send trusts its caller; make sure this really is a draft.
            core.get_draft(draft_id).await?;
            let r = core
                .queue_send(QueueSendArgs {
                    draft_id,
                    send_at: None,
                })
                .await?;
            json!({
                "status": "queued",
                "sends_at": iso(r.dispatch_at),
                "note": "The user can still cancel it in comail until it is sent.",
            })
        }
        "deletion_status" => {
            let ids = serde_json::from_value(args["action_ids"].clone())
                .map_err(|_| "action_ids must be an array of integers".to_string())?;
            json!(core.deletion_status(ids).await?)
        }
        "modify_threads" => {
            let action = args["action"].as_str().unwrap_or("");
            let kind = ActionKind::from_str(action)
                .filter(|k| *k != ActionKind::Send)
                .ok_or_else(|| format!("unknown action: {action}"))?;
            let thread_ids: Vec<i64> = serde_json::from_value(args["thread_ids"].clone())
                .map_err(|_| "thread_ids must be an array of integers".to_string())?;
            if thread_ids.is_empty() {
                return Err("thread_ids is empty".into());
            }
            let wake_at = match args["snooze_until"].as_str() {
                Some(s) => Some(parse_time(s)?),
                None => None,
            };
            if kind == ActionKind::Snooze && wake_at.is_none() {
                return Err("snooze needs snooze_until".into());
            }
            if matches!(kind, ActionKind::AddLabel | ActionKind::RemoveLabel)
                && args["label_id"].as_i64().is_none()
            {
                return Err(format!("{action} needs label_id"));
            }
            if kind == ActionKind::Move && args["folder_id"].as_i64().is_none() {
                return Err("move needs folder_id".into());
            }
            let count = thread_ids.len();
            let result = core
                .perform_action(PerformActionArgs {
                    kind,
                    thread_ids,
                    params: Some(ActionParams {
                        wake_at,
                        target_folder_id: opt_i64(&args, "folder_id"),
                        label_id: opt_i64(&args, "label_id"),
                    }),
                })
                .await?;
            json!({ "status": if kind == ActionKind::DeletePermanently { "queued" } else { "done" }, "action": action, "threads": count, "action_ids": result.action_ids })
        }
        _ => return Err(format!("{UNKNOWN_TOOL}: {name}")),
    };
    Ok(match out {
        Value::String(s) => s,
        v => v.to_string(),
    })
}

fn str_arg(args: &Value, key: &str) -> std::result::Result<String, String> {
    args[key]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("missing string argument: {key}"))
}

fn i64_arg(args: &Value, key: &str) -> std::result::Result<i64, String> {
    args[key]
        .as_i64()
        .ok_or_else(|| format!("missing integer argument: {key}"))
}

fn opt_i64(args: &Value, key: &str) -> Option<i64> {
    args[key].as_i64()
}

fn addrs_arg(args: &Value, key: &str) -> std::result::Result<Vec<Address>, String> {
    match &args[key] {
        Value::Null => Ok(Vec::new()),
        Value::String(s) => s
            .split(',')
            .filter(|p| !p.trim().is_empty())
            .map(parse_address)
            .collect(),
        Value::Array(items) => items
            .iter()
            .map(|v| {
                v.as_str()
                    .ok_or_else(|| format!("{key} must be strings"))
                    .and_then(parse_address)
            })
            .collect(),
        _ => Err(format!("{key} must be an array of addresses")),
    }
}

/// "a@b.com" or "Name <a@b.com>".
pub(super) fn parse_address(raw: &str) -> std::result::Result<Address, String> {
    let raw = raw.trim();
    let (name, email) = match (raw.rfind('<'), raw.rfind('>')) {
        (Some(l), Some(r)) if l < r => {
            let name = raw[..l].trim().trim_matches('"').trim();
            (
                (!name.is_empty()).then(|| name.to_string()),
                raw[l + 1..r].trim().to_string(),
            )
        }
        _ => (None, raw.to_string()),
    };
    let valid = email.split_once('@').is_some_and(|(local, domain)| {
        !local.is_empty() && domain.contains('.') && !email.contains(char::is_whitespace)
    });
    if !valid {
        return Err(format!("not an email address: {raw}"));
    }
    Ok(Address { name, email })
}

fn parse_time(s: &str) -> std::result::Result<i64, String> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Ok(dt.timestamp_millis());
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        return dt
            .and_local_timezone(chrono::Local)
            .earliest()
            .map(|d| d.timestamp_millis())
            .ok_or_else(|| format!("invalid local time: {s}"));
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return d
            .and_hms_opt(0, 0, 0)
            .and_then(|dt| dt.and_local_timezone(chrono::Local).earliest())
            .map(|d| d.timestamp_millis())
            .ok_or_else(|| format!("invalid date: {s}"));
    }
    Err(format!("expected an ISO 8601 date or time, got: {s}"))
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.with_timezone(&chrono::Local).to_rfc3339())
        .unwrap_or_default()
}

fn addr_str(a: &Address) -> String {
    match &a.name {
        Some(n) if !n.is_empty() => format!("{n} <{}>", a.email),
        _ => a.email.clone(),
    }
}

fn thread_json(t: &ThreadSummary) -> Value {
    json!({
        "thread_id": t.id,
        "account": t.account_email,
        "subject": t.subject,
        "snippet": crate::ai::clean_untrusted(&t.snippet),
        "participants": t.participants.iter().map(addr_str).collect::<Vec<_>>(),
        "last_message_at": iso(t.last_message_at),
        "messages": t.message_count,
        "unread": t.unread_count,
        "starred": t.is_starred,
        "has_attachments": t.has_attachments,
        "label_ids": t.labels,
    })
}

/// Readable text for a message: the text part, else the HTML stripped.
fn plain_body(m: &MessageDetail) -> String {
    let raw = match (&m.text_body, &m.html_body) {
        (Some(t), _) if !t.trim().is_empty() => t.clone(),
        (_, Some(h)) => strip_html(h),
        _ => m.snippet.clone(),
    };
    crate::ai::clean_untrusted(&raw)
}

fn strip_html(html: &str) -> String {
    use once_cell::sync::Lazy;
    static BLOCKS: Lazy<regex::Regex> = Lazy::new(|| {
        regex::Regex::new(r"(?is)<(script|style|head)[^>]*>.*?</(script|style|head)>").unwrap()
    });
    static BREAKS: Lazy<regex::Regex> =
        Lazy::new(|| regex::Regex::new(r"(?i)<(br|/p|/div|/tr|/li|/h[1-6])[^>]*>").unwrap());
    static TAGS: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r"<[^>]+>").unwrap());
    static BLANKS: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r"\n\s*\n\s*\n+").unwrap());
    let s = BLOCKS.replace_all(html, "");
    let s = BREAKS.replace_all(&s, "\n");
    let s = TAGS.replace_all(&s, "");
    let s = s
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    BLANKS.replace_all(s.trim(), "\n\n").into_owned()
}

fn message_json(m: &MessageDetail) -> Value {
    let pending = m.body_state == "none" || m.body_state == "fetching";
    let body = plain_body(m);
    let truncated = body.chars().count() > BODY_LIMIT;
    let body: String = body.chars().take(BODY_LIMIT).collect();
    json!({
        "message_id": m.id,
        "thread_id": m.thread_id,
        "from": addr_str(&m.from),
        "to": m.to.iter().map(addr_str).collect::<Vec<_>>(),
        "cc": m.cc.iter().map(addr_str).collect::<Vec<_>>(),
        "subject": m.subject,
        "date": iso(m.date),
        "read": m.is_read,
        "starred": m.is_starred,
        "is_draft": m.is_draft,
        "sent_by_user": m.is_outgoing,
        "body": body,
        "body_truncated": truncated,
        "body_pending": pending,
        "attachments": m.attachments.iter().filter(|a| !a.is_inline).map(|a| json!({
            "filename": a.filename,
            "mime_type": a.mime_type,
            "size": a.size,
        })).collect::<Vec<_>>(),
    })
}

/// Build the reply draft the composer would: recipients, "Re:" subject and the
/// original quoted under the new text.
fn reply_draft(
    original: &MessageDetail,
    body: &str,
    reply_all: bool,
    own: &[String],
) -> SaveDraftArgs {
    let is_own = |a: &Address| own.contains(&a.email.to_lowercase());
    // Replying to something the user sent goes back to its recipients.
    let to: Vec<Address> = if original.is_outgoing || is_own(&original.from) {
        original.to.clone()
    } else {
        vec![original.from.clone()]
    };
    let mut cc: Vec<Address> = Vec::new();
    if reply_all {
        for a in original.to.iter().chain(&original.cc) {
            let dup = to
                .iter()
                .chain(&cc)
                .any(|b| b.email.eq_ignore_ascii_case(&a.email));
            if !dup && !is_own(a) {
                cc.push(a.clone());
            }
        }
    }
    let subject = if original.subject.to_lowercase().starts_with("re:") {
        original.subject.clone()
    } else {
        format!("Re: {}", original.subject)
    };
    let quoted: String = plain_body(original)
        .chars()
        .take(BODY_LIMIT)
        .collect::<String>()
        .lines()
        .map(|l| format!("> {l}"))
        .collect::<Vec<_>>()
        .join("\n");
    let date = chrono::DateTime::from_timestamp_millis(original.date)
        .map(|d| {
            d.with_timezone(&chrono::Local)
                .format("%a, %b %-d, %Y at %H:%M")
                .to_string()
        })
        .unwrap_or_default();
    SaveDraftArgs {
        draft_id: None,
        account_id: original.account_id,
        to,
        cc,
        bcc: Vec::new(),
        subject,
        body_text: format!(
            "{body}\n\nOn {date}, {} wrote:\n{quoted}\n",
            addr_str(&original.from)
        ),
        body_html: None,
        mode: if reply_all { "reply_all" } else { "reply" }.into(),
        in_reply_to_message_id: Some(original.id),
        attachments: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_addresses() {
        let a = parse_address("Ada Lovelace <ada@example.com>").unwrap();
        assert_eq!(a.name.as_deref(), Some("Ada Lovelace"));
        assert_eq!(a.email, "ada@example.com");
        let b = parse_address(" bob@example.org ").unwrap();
        assert_eq!(b.name, None);
        assert!(parse_address("not an address").is_err());
        assert!(parse_address("x@localhost").is_err());
    }

    #[test]
    fn permissions_filter_tools() {
        let mut s = Settings::default();
        let names = |s: &Settings| -> Vec<String> {
            list(s)
                .iter()
                .map(|t| t["name"].as_str().unwrap().to_string())
                .collect()
        };
        let default = names(&s);
        assert!(default.contains(&"search_emails".to_string()));
        assert!(default.contains(&"create_draft".to_string()));
        assert!(!default.contains(&"send_draft".to_string()));
        assert!(!default.contains(&"modify_threads".to_string()));
        s.mcp_allow_drafts = false;
        s.mcp_allow_send = true;
        s.mcp_allow_actions = true;
        let all = names(&s);
        assert!(!all.contains(&"create_draft".to_string()));
        assert!(all.contains(&"send_draft".to_string()));
        assert!(all.contains(&"modify_threads".to_string()));
    }

    #[test]
    fn permanent_delete_is_an_independent_opt_in() {
        let mut s = Settings::default();
        assert!(!s.mcp_allow_permanent_delete);
        assert!(!permanent_delete_allowed(&s));
        s.mcp_allow_permanent_delete = true;
        assert!(!permanent_delete_allowed(&s), "needs mcp_allow_actions too");
        s.mcp_allow_actions = true;
        assert!(permanent_delete_allowed(&s));
        s.mcp_allow_permanent_delete = false;
        assert!(!permanent_delete_allowed(&s), "actions alone is not enough");
    }

    #[test]
    fn action_kind_roundtrips_delete_permanently() {
        assert_eq!(
            ActionKind::from_str(ActionKind::DeletePermanently.as_str()),
            Some(ActionKind::DeletePermanently)
        );
    }

    #[test]
    fn strips_html() {
        let t = strip_html("<style>p{}</style><p>Hello&nbsp;<b>there</b></p><br>Bye &amp; out");
        assert_eq!(t, "Hello there\n\nBye & out");
    }

    #[test]
    fn reply_all_skips_self_and_duplicates() {
        let addr = |e: &str| Address {
            name: None,
            email: e.into(),
        };
        let original = MessageDetail {
            id: 7,
            thread_id: 3,
            account_id: 1,
            from: addr("alice@example.com"),
            to: vec![addr("me@example.com"), addr("bob@example.com")],
            cc: vec![addr("Alice@example.com"), addr("carol@example.com")],
            subject: "Plans".into(),
            date: 0,
            is_read: true,
            is_starred: false,
            is_draft: false,
            is_outgoing: false,
            snippet: String::new(),
            body_state: "full".into(),
            text_body: Some("See you\nthen".into()),
            html_body: None,
            automation_note: None,
            attachments: Vec::new(),
            list_unsubscribe: None,
            list_unsubscribe_post: None,
            via: None,
            send_state: None,
            send_error: None,
            verification_code: None,
        };
        let d = reply_draft(&original, "Sounds good", true, &["me@example.com".into()]);
        assert_eq!(d.subject, "Re: Plans");
        assert_eq!(d.to, vec![addr("alice@example.com")]);
        assert_eq!(
            d.cc,
            vec![addr("bob@example.com"), addr("carol@example.com")]
        );
        assert_eq!(d.mode, "reply_all");
        assert!(d.body_text.contains("> See you\n> then"));
    }
}
