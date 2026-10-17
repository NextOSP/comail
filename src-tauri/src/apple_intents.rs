//! Rust side of the Siri / Shortcuts actions in `swift/ComailIntents.swift`.
//!
//! The Swift intents send `{"action": ..., ...}` JSON through the handler
//! installed here; each request is answered exactly once with
//! `{"ok", "dialog", "value"?, "number"?}` - `dialog` is what Siri says.

use crate::AppState;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// How far back "my latest code" looks.
const CODE_MAX_AGE_MINUTES: i64 = 30;

#[cfg(apple_intents)]
mod ffi {
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::sync::OnceLock;
    use tauri::AppHandle;

    pub type Reply = extern "C" fn(*mut c_void, *const c_char);
    type Handler = extern "C" fn(*const c_char, *mut c_void, Reply);

    unsafe extern "C" {
        fn comail_intents_install(handler: Handler);
    }

    static APP: OnceLock<AppHandle> = OnceLock::new();

    pub fn install(app: AppHandle) {
        if APP.set(app).is_ok() {
            unsafe { comail_intents_install(on_request) };
        }
    }

    extern "C" fn on_request(request: *const c_char, ctx: *mut c_void, reply: Reply) {
        let request = if request.is_null() {
            String::new()
        } else {
            unsafe { CStr::from_ptr(request) }
                .to_string_lossy()
                .into_owned()
        };
        // Raw pointers aren't Send; the Swift side keeps `ctx` alive until the
        // reply, so carrying it across the task as an address is sound.
        let ctx = ctx as usize;
        let app = APP.get().cloned();
        tauri::async_runtime::spawn(async move {
            let answer = match app {
                Some(app) => super::handle(&app, &request).await,
                None => super::reply(false, "Comail is still starting up."),
            };
            let text = CString::new(answer.to_string().replace('\0', "")).unwrap_or_default();
            reply(ctx as *mut c_void, text.as_ptr());
        });
    }
}

/// Register the intent handler (no-op where the bridge isn't built).
pub fn install(app: &AppHandle) {
    #[cfg(apple_intents)]
    ffi::install(app.clone());
    #[cfg(not(apple_intents))]
    let _ = app;
}

fn reply(ok: bool, dialog: impl Into<String>) -> Value {
    json!({ "ok": ok, "dialog": dialog.into() })
}

#[cfg_attr(not(apple_intents), allow(dead_code))]
async fn handle(app: &AppHandle, request: &str) -> Value {
    let req: Value = serde_json::from_str(request).unwrap_or_default();
    let arg = |key: &str| req[key].as_str().unwrap_or("").trim().to_string();
    let Some(state) = app.try_state::<AppState>() else {
        return reply(false, "Comail is still starting up. Try again in a moment.");
    };
    let core = state.core.clone();
    match req["action"].as_str().unwrap_or("") {
        "verificationCode" => match core.latest_verification_code(CODE_MAX_AGE_MINUTES).await {
            Ok(Some(found)) => {
                let copied = app.clipboard().write_text(found.code.clone()).is_ok();
                let dialog = if copied {
                    format!(
                        "Your code from {} is {}. It's on your clipboard.",
                        found.sender, found.code
                    )
                } else {
                    format!("Your code from {} is {}.", found.sender, found.code)
                };
                json!({ "ok": true, "dialog": dialog, "value": found.code })
            }
            Ok(None) => reply(
                false,
                format!(
                    "I didn't find a verification code in the last {CODE_MAX_AGE_MINUTES} minutes."
                ),
            ),
            Err(e) => reply(false, format!("Comail couldn't read your mail: {e}")),
        },
        "unread" => match core.unread_counts(None).await {
            Ok(counts) => {
                let n = counts.important;
                let dialog = match n {
                    0 => "No unread important email. You're all caught up.".to_string(),
                    1 => "You have 1 unread important email.".to_string(),
                    n => format!("You have {n} unread important emails."),
                };
                json!({ "ok": true, "dialog": dialog, "number": n })
            }
            Err(e) => reply(false, format!("Comail couldn't count your mail: {e}")),
        },
        "catchUp" => match core.inbox_brief().await {
            Ok(text) => json!({ "ok": true, "dialog": text, "value": text }),
            Err(e) => reply(false, format!("Comail couldn't catch you up: {e}")),
        },
        "ask" => {
            let question = arg("question");
            if question.is_empty() {
                return reply(false, "What do you want to know about your email?");
            }
            let request_id = format!("siri-{}", std::process::id() as u64 ^ now_nanos());
            match core.ai_ask(question, request_id).await {
                Ok(result) => {
                    let answer = strip_citations(&result.answer);
                    json!({ "ok": true, "dialog": answer, "value": answer })
                }
                Err(comail_core::error::CoreError::AiNotConfigured) => reply(
                    false,
                    "Set up an AI provider in Comail's settings first - Apple Intelligence works with no key.",
                ),
                Err(e) => reply(false, format!("Comail couldn't answer that: {e}")),
            }
        }
        "compose" => {
            crate::forward_mailto(app, &mailto(&arg("to"), &arg("subject"), &arg("body")));
            reply(true, "Opening a new email.")
        }
        "search" => {
            let query = arg("query");
            crate::show_main(app);
            let _ = app.emit("intent:search", query);
            reply(true, "Searching Comail.")
        }
        other => reply(false, format!("Comail doesn't know how to \"{other}\".")),
    }
}

fn now_nanos() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

/// Drop "[1]"-style source markers, which read badly when spoken.
fn strip_citations(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        let digits = after
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == ',' || *c == ' ')
            .count();
        if digits > 0 && after[digits..].starts_with(']') {
            out.push_str(rest[..open].trim_end_matches(' '));
            rest = &after[digits + 1..];
        } else {
            out.push_str(&rest[..=open]);
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// Build a `mailto:` URL the existing deep-link path can open.
fn mailto(to: &str, subject: &str, body: &str) -> String {
    let enc = |s: &str| url_escape(s);
    let mut params = Vec::new();
    if !subject.is_empty() {
        params.push(format!("subject={}", enc(subject)));
    }
    if !body.is_empty() {
        params.push(format!("body={}", enc(body)));
    }
    let mut url = format!("mailto:{}", enc(to));
    if !params.is_empty() {
        url.push('?');
        url.push_str(&params.join("&"));
    }
    url
}

fn url_escape(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'@' | b',' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_citation_markers() {
        assert_eq!(
            strip_citations("Ana wants the Q3 slide moved [1]. Ben agreed [2, 3]."),
            "Ana wants the Q3 slide moved. Ben agreed."
        );
        assert_eq!(strip_citations("see [notes] here"), "see [notes] here");
    }

    #[test]
    fn builds_mailto() {
        assert_eq!(mailto("", "", ""), "mailto:");
        assert_eq!(
            mailto("ana@x.com", "Hi there", "Line 1\nA&B"),
            "mailto:ana@x.com?subject=Hi%20there&body=Line%201%0AA%26B"
        );
    }
}
