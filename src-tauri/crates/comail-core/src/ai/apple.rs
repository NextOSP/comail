//! Apple Intelligence: Apple's on-device Foundation Model (macOS 26+, Apple
//! silicon), reached through the Swift bridge in `swift/AppleIntelligence.swift`.
//!
//! Selected by setting the AI base URL to [`BASE_URL`]; every chat entry point
//! in [`super`] routes here. Nothing leaves the machine and no API key is
//! needed. The model has a small (4096-token) context window and no
//! OpenAI-style tool calling, so prompts are fitted to [`INPUT_TOKEN_BUDGET`]
//! here and callers skip agentic tool rounds via [`is_apple`].

use crate::error::{CoreError, Result};

/// Sentinel "base URL" that selects the on-device provider.
pub const BASE_URL: &str = "apple://intelligence";
/// The single model id the provider exposes (shown in usage stats).
pub const MODEL_ID: &str = "apple-intelligence";

/// Total context window of the system model (prompt + response).
const CONTEXT_TOKENS: usize = 4096;
/// Prompt allowance, leaving room for the response.
pub const INPUT_TOKEN_BUDGET: usize = CONTEXT_TOKENS - 1200;

pub fn is_apple(base_url: &str) -> bool {
    base_url.trim().to_ascii_lowercase().starts_with("apple:")
}

/// Character budget for a mail-context block (thread / excerpts) when the
/// provider is on-device; other providers keep `default`.
pub fn context_chars(base_url: &str, default: usize) -> usize {
    if is_apple(base_url) {
        default.min(6_000)
    } else {
        default
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    Available,
    /// Hardware can't run it (Intel Mac).
    DeviceNotEligible,
    /// Apple Intelligence is turned off in System Settings.
    NotEnabled,
    /// The model is still downloading / preparing.
    ModelNotReady,
    /// macOS older than 26.
    OsTooOld,
    /// Not macOS, or this build was made without the FoundationModels SDK.
    Unsupported,
}

impl Availability {
    pub fn as_str(self) -> &'static str {
        match self {
            Availability::Available => "available",
            Availability::DeviceNotEligible => "deviceNotEligible",
            Availability::NotEnabled => "notEnabled",
            Availability::ModelNotReady => "modelNotReady",
            Availability::OsTooOld => "osTooOld",
            Availability::Unsupported => "unsupported",
        }
    }

    fn explain(self) -> &'static str {
        match self {
            Availability::Available => "Apple Intelligence is available",
            Availability::DeviceNotEligible => "Apple Intelligence needs a Mac with Apple silicon",
            Availability::NotEnabled => {
                "Apple Intelligence is turned off - enable it in System Settings > Apple Intelligence & Siri"
            }
            Availability::ModelNotReady => {
                "The Apple Intelligence model is still downloading - try again in a few minutes"
            }
            Availability::OsTooOld => "Apple Intelligence needs macOS 26 or later",
            Availability::Unsupported => "Apple Intelligence isn't supported in this build",
        }
    }
}

#[cfg(apple_intelligence)]
mod ffi {
    use std::ffi::{CStr, c_char, c_void};
    use tokio::sync::mpsc::UnboundedSender;

    pub const DELTA: i32 = 0;
    pub const DONE: i32 = 1;
    pub const CONTEXT_EXCEEDED: i32 = 3;
    pub const GUARDRAIL: i32 = 4;
    pub const UNSUPPORTED_LANGUAGE: i32 = 5;

    pub type Callback = extern "C" fn(*mut c_void, i32, *const c_char);

    unsafe extern "C" {
        pub fn comail_fm_availability() -> i32;
        pub fn comail_fm_respond(
            instructions: *const c_char,
            prompt: *const c_char,
            stream: i32,
            ctx: *mut c_void,
            cb: Callback,
        );
    }

    pub type Sender = UnboundedSender<(i32, String)>;

    /// Called by Swift (on any thread). `ctx` is a leaked `Box<Sender>`: shared
    /// for deltas, reclaimed on the single terminal event.
    pub extern "C" fn on_event(ctx: *mut c_void, kind: i32, text: *const c_char) {
        let text = if text.is_null() {
            String::new()
        } else {
            unsafe { CStr::from_ptr(text) }
                .to_string_lossy()
                .into_owned()
        };
        if kind == DELTA {
            let tx = unsafe { &*(ctx as *const Sender) };
            let _ = tx.send((kind, text));
        } else {
            let tx = unsafe { Box::from_raw(ctx as *mut Sender) };
            let _ = tx.send((kind, text));
        }
    }
}

pub fn availability() -> Availability {
    #[cfg(apple_intelligence)]
    {
        match unsafe { ffi::comail_fm_availability() } {
            0 => Availability::Available,
            1 => Availability::DeviceNotEligible,
            2 => Availability::NotEnabled,
            3 => Availability::ModelNotReady,
            4 => Availability::OsTooOld,
            _ => Availability::Unsupported,
        }
    }
    #[cfg(not(apple_intelligence))]
    {
        Availability::Unsupported
    }
}

/// Rough token estimate for the on-device tokenizer: ~3.5 chars per token for
/// ASCII text, about one per character for CJK and other non-ASCII scripts.
fn approx_tokens(text: &str) -> usize {
    let (ascii, other) = text.chars().fold((0usize, 0usize), |(a, o), c| {
        if c.is_ascii() { (a + 1, o) } else { (a, o + 1) }
    });
    ascii * 2 / 7 + other + 1
}

/// Cut `text` to about `keep` chars, keeping its head and tail (the question
/// or newest content usually sits at one end) around an omission marker.
fn trim_middle(text: &str, keep: usize) -> String {
    let total = text.chars().count();
    if total <= keep {
        return text.to_string();
    }
    let head = keep * 3 / 5;
    let tail = keep - head;
    let start: String = text.chars().take(head).collect();
    let end: String = text.chars().skip(total - tail).collect();
    format!("{start}\n[... trimmed to fit the on-device model ...]\n{end}")
}

/// Flatten an OpenAI-style conversation into the model's (instructions,
/// prompt) pair: system turns are trusted instructions, everything else
/// (which carries untrusted email text) becomes the prompt.
fn flatten(messages: &[(String, String)]) -> (String, String) {
    let mut instructions: Vec<&str> = Vec::new();
    let mut turns: Vec<(&str, &str)> = Vec::new();
    for (role, content) in messages {
        if content.trim().is_empty() {
            continue;
        }
        if role == "system" {
            instructions.push(content);
        } else {
            turns.push((role, content));
        }
    }
    let prompt = if turns.len() == 1 {
        turns[0].1.to_string()
    } else {
        turns
            .iter()
            .map(|(role, content)| {
                let label = match *role {
                    "assistant" => "Assistant",
                    "tool" => "Search results",
                    _ => "User",
                };
                format!("{label}:\n{content}")
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    (instructions.join("\n\n"), prompt)
}

/// Shrink the longest messages until the conversation fits `budget` tokens.
fn fit(mut messages: Vec<(String, String)>, budget: usize) -> Vec<(String, String)> {
    for _ in 0..12 {
        let total: usize = messages.iter().map(|(_, c)| approx_tokens(c)).sum();
        if total <= budget {
            break;
        }
        let Some((i, _)) = messages
            .iter()
            .enumerate()
            .max_by_key(|(_, (_, c))| approx_tokens(c))
        else {
            break;
        };
        let content = &messages[i].1;
        let tokens = approx_tokens(content);
        let excess = total - budget;
        let chars = content.chars().count();
        // Scale the cut by this message's chars-per-token, plus a little slack.
        let keep_tokens = tokens.saturating_sub(excess + 32).max(64);
        let keep = (chars * keep_tokens / tokens.max(1)).max(200);
        if keep >= chars {
            break;
        }
        messages[i].1 = trim_middle(content, keep);
    }
    messages
}

/// One generation over `messages` (role, content). With `stream`, `on_delta`
/// receives answer text as it's produced. Retries with a tighter budget if the
/// model still reports the context window as exceeded.
pub async fn generate(
    messages: Vec<(String, String)>,
    stream: bool,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> Result<String> {
    let state = availability();
    if state != Availability::Available {
        return Err(CoreError::Other(state.explain().into()));
    }
    let mut budget = INPUT_TOKEN_BUDGET;
    let mut last_err = None;
    for _ in 0..3 {
        let (instructions, prompt) = flatten(&fit(messages.clone(), budget));
        let mut streamed = false;
        let mut forward = |d: &str| {
            streamed = true;
            on_delta(d);
        };
        match respond(&instructions, &prompt, stream, &mut forward).await {
            Err(Failure::ContextExceeded(msg)) if !streamed => {
                budget = budget * 3 / 5;
                last_err = Some(msg);
            }
            Err(Failure::ContextExceeded(msg)) => return Err(CoreError::Other(msg)),
            Err(Failure::Other(e)) => return Err(e),
            Ok(text) => return Ok(text),
        }
    }
    Err(CoreError::Other(format!(
        "this email is too long for the on-device model ({})",
        last_err.unwrap_or_default()
    )))
}

#[cfg_attr(not(apple_intelligence), allow(dead_code))]
enum Failure {
    ContextExceeded(String),
    Other(CoreError),
}

#[cfg(apple_intelligence)]
async fn respond(
    instructions: &str,
    prompt: &str,
    stream: bool,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> std::result::Result<String, Failure> {
    use std::ffi::CString;
    let cstr = |s: &str| CString::new(s.replace('\0', "")).unwrap_or_default();
    let (instructions, prompt) = (cstr(instructions), cstr(prompt));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(i32, String)>();
    {
        let ctx = Box::into_raw(Box::new(tx)) as *mut std::ffi::c_void;
        // Swift copies both strings before returning and owns `ctx` until it
        // fires the terminal callback (which frees it).
        unsafe {
            ffi::comail_fm_respond(
                instructions.as_ptr(),
                prompt.as_ptr(),
                stream as i32,
                ctx,
                ffi::on_event,
            )
        };
    }
    while let Some((kind, text)) = rx.recv().await {
        match kind {
            ffi::DELTA => on_delta(&text),
            ffi::DONE => return Ok(text),
            ffi::CONTEXT_EXCEEDED => return Err(Failure::ContextExceeded(text)),
            ffi::GUARDRAIL => {
                return Err(Failure::Other(CoreError::Other(format!(
                    "Apple Intelligence declined this request ({text})"
                ))));
            }
            ffi::UNSUPPORTED_LANGUAGE => {
                return Err(Failure::Other(CoreError::Other(format!(
                    "Apple Intelligence doesn't support this language yet ({text})"
                ))));
            }
            _ => {
                return Err(Failure::Other(CoreError::Other(format!(
                    "Apple Intelligence: {text}"
                ))));
            }
        }
    }
    Err(Failure::Other(CoreError::Other(
        "Apple Intelligence stopped without a response".into(),
    )))
}

#[cfg(not(apple_intelligence))]
async fn respond(
    _instructions: &str,
    _prompt: &str,
    _stream: bool,
    _on_delta: &mut (dyn FnMut(&str) + Send),
) -> std::result::Result<String, Failure> {
    Err(Failure::Other(CoreError::Other(
        Availability::Unsupported.explain().into(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(role: &str, content: &str) -> (String, String) {
        (role.to_string(), content.to_string())
    }

    #[test]
    fn detects_sentinel() {
        assert!(is_apple(BASE_URL));
        assert!(is_apple(" Apple://intelligence "));
        assert!(!is_apple("https://openrouter.ai/api/v1"));
        assert_eq!(context_chars(BASE_URL, 24_000), 6_000);
        assert_eq!(context_chars("http://localhost:1234/v1", 24_000), 24_000);
    }

    #[test]
    fn flattens_system_into_instructions() {
        let (i, p) = flatten(&[m("system", "Be brief."), m("user", "Hello")]);
        assert_eq!(i, "Be brief.");
        assert_eq!(p, "Hello");

        let (i, p) = flatten(&[
            m("system", "A"),
            m("user", "Q"),
            m("assistant", ""),
            m("tool", "R"),
            m("system", "B"),
        ]);
        assert_eq!(i, "A\n\nB");
        assert_eq!(p, "User:\nQ\n\nSearch results:\nR");
    }

    #[test]
    fn fit_trims_longest_message_keeping_both_ends() {
        let long = format!("HEAD{}TAIL", "word ".repeat(10_000));
        let fitted = fit(vec![m("system", "Summarize."), m("user", &long)], 1000);
        let total: usize = fitted.iter().map(|(_, c)| approx_tokens(c)).sum();
        assert!(total <= 1000, "still {total} tokens");
        assert_eq!(fitted[0].1, "Summarize.");
        assert!(fitted[1].1.starts_with("HEAD"));
        assert!(fitted[1].1.ends_with("TAIL"));
    }

    #[test]
    fn fit_leaves_short_prompts_alone() {
        let msgs = vec![m("system", "x"), m("user", "short")];
        assert_eq!(fit(msgs.clone(), 1000), msgs);
    }

    /// Real generation on this Mac's model: `cargo test -p comail-core
    /// apple -- --ignored`. Skips quietly where the model isn't available.
    #[tokio::test]
    #[ignore]
    async fn live_generation() {
        if availability() != Availability::Available {
            eprintln!("skipping: {}", availability().as_str());
            return;
        }
        let msgs = vec![
            m("system", "Answer in one short sentence."),
            m("user", "What is the capital of France?"),
        ];
        let mut deltas = String::new();
        let text = generate(msgs.clone(), true, &mut |d| deltas.push_str(d))
            .await
            .unwrap();
        assert!(text.contains("Paris"), "{text}");
        assert_eq!(deltas, text);

        let plain = generate(msgs, false, &mut |_| {}).await.unwrap();
        assert!(plain.contains("Paris"), "{plain}");

        // Far over the window: trimmed to fit instead of failing.
        let huge = format!(
            "Summarize in one sentence:\n{}",
            "The meeting moved to Friday. ".repeat(3000)
        );
        let text = generate(vec![m("user", &huge)], false, &mut |_| {})
            .await
            .unwrap();
        assert!(!text.trim().is_empty());
    }

    #[test]
    fn cjk_counts_heavier_than_ascii() {
        assert!(approx_tokens(&"中".repeat(100)) > approx_tokens(&"a".repeat(100)) * 2);
    }
}
