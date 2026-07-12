//! AI features over any OpenAI-compatible chat-completions API (OpenRouter
//! by default). The API key lives in the OS keyring; base URL and model are
//! user settings. Requests use HTTP/1.0 over rustls so responses are never
//! chunk-encoded (keeps the tiny built-in client simple).

use crate::error::{CoreError, Result};
use serde_json::json;

pub const DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";
pub const DEFAULT_MODEL: &str = "openai/gpt-4o-mini";

pub struct AiConfig {
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ChatMessage {
    pub role: &'static str,
    pub content: String,
}

async fn read_all<S>(mut stream: S, req: &str, timeout_secs: u64) -> Result<Vec<u8>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    stream.write_all(req.as_bytes()).await?;
    let mut resp = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        stream.read_to_end(&mut resp),
    )
    .await
    .map_err(|_| CoreError::Other("ai request timed out".into()))??;
    Ok(resp)
}

/// Minimal HTTP/1.0 request. `https://` uses rustls; plain `http://` is
/// supported for local endpoints (LM Studio, Ollama). Empty bearer sends
/// no Authorization header (local servers need no key).
/// Parse an endpoint URL into (host, port, https, path).
fn parse_endpoint(url: &str) -> Result<(String, u16, bool, String)> {
    let parsed = url::Url::parse(url).map_err(|e| CoreError::Other(format!("bad ai url: {e}")))?;
    let https = match parsed.scheme() {
        "https" => true,
        "http" => false,
        s => return Err(CoreError::Other(format!("unsupported ai url scheme: {s}"))),
    };
    let host = parsed
        .host_str()
        .ok_or_else(|| CoreError::Other("bad ai url".into()))?
        .to_string();
    let port = parsed.port().unwrap_or(if https { 443 } else { 80 });
    Ok((host, port, https, parsed.path().to_string()))
}

/// Build a bare HTTP/1.0 request line + headers (+ optional JSON body).
fn format_request(method: &str, path: &str, host: &str, bearer: &str, payload: &str) -> String {
    let auth = if bearer.is_empty() {
        String::new()
    } else {
        format!("Authorization: Bearer {bearer}\r\n")
    };
    let content = if payload.is_empty() {
        String::new()
    } else {
        format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            payload.len()
        )
    };
    format!(
        "{method} {path} HTTP/1.0\r\nHost: {host}\r\n{auth}{content}\
         Accept: application/json\r\nConnection: close\r\n\r\n{payload}"
    )
}

async fn http_request(
    url: &str,
    method: &str,
    bearer: &str,
    payload: Option<String>,
    timeout_secs: u64,
) -> Result<String> {
    let (host, port, https, path) = parse_endpoint(url)?;
    let req = format_request(method, &path, &host, bearer, payload.as_deref().unwrap_or(""));

    let tcp = tokio::net::TcpStream::connect((host.as_str(), port)).await?;
    let raw = if https {
        let connector = crate::imap::tls_connector();
        let server_name = rustls::pki_types::ServerName::try_from(host.clone())
            .map_err(|e| CoreError::Tls(e.to_string()))?;
        let stream = connector
            .connect(server_name, tcp)
            .await
            .map_err(|e| CoreError::Tls(e.to_string()))?;
        read_all(stream, &req, timeout_secs).await?
    } else {
        read_all(tcp, &req, timeout_secs).await?
    };

    let resp = String::from_utf8_lossy(&raw);
    let (head, body) = resp
        .split_once("\r\n\r\n")
        .ok_or_else(|| CoreError::Other("malformed ai response".into()))?;
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("0");
    if !status.starts_with('2') {
        return Err(CoreError::Other(format!(
            "ai api error {status}: {}",
            body.chars().take(400).collect::<String>()
        )));
    }
    Ok(body.to_string())
}

async fn http_post_json(url: &str, bearer: &str, body: &serde_json::Value) -> Result<String> {
    http_request(url, "POST", bearer, Some(serde_json::to_string(body)?), 120).await
}

async fn http_get_json(url: &str, bearer: &str) -> Result<String> {
    http_request(url, "GET", bearer, None, 30).await
}

/// Model ids from the endpoint's `GET /models` (OpenAI-compatible).
/// Works without a key on OpenRouter; other endpoints may require one.
pub async fn list_models(base_url: &str, api_key: &str) -> Result<Vec<String>> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let raw = http_get_json(&url, api_key).await?;
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| CoreError::Other("unparseable models response".into()))?;
    let mut ids: Vec<String> = parsed["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    Ok(ids)
}

/// One chat completion; returns the assistant's text.
pub async fn chat(cfg: &AiConfig, messages: Vec<ChatMessage>) -> Result<String> {
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = json!({
        "model": cfg.model,
        "messages": messages,
    });
    let raw = http_post_json(&url, &cfg.api_key, &body).await?;
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| CoreError::Other("unparseable ai response".into()))?;
    if let Some(err) = parsed.get("error") {
        return Err(CoreError::Other(format!("ai api: {err}")));
    }
    parsed["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| CoreError::Other("ai response had no content".into()))
}

/// Streaming chat completion. Calls `on_delta` with each incremental content
/// chunk as it arrives and returns the full concatenated answer. If the
/// endpoint yields no streamed content (e.g. it ignored `stream:true`), falls
/// back to a single non-streaming completion so callers still get an answer.
pub async fn chat_stream(
    cfg: &AiConfig,
    messages: Vec<ChatMessage>,
    mut on_delta: impl FnMut(&str) + Send,
) -> Result<String> {
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = json!({ "model": cfg.model, "messages": messages.clone(), "stream": true });
    let full = http_post_sse(&url, &cfg.api_key, &body, &mut on_delta).await?;
    if !full.trim().is_empty() {
        return Ok(full);
    }
    // Endpoint didn't stream anything usable - fall back to a plain completion.
    let text = chat(cfg, messages).await?;
    if !text.is_empty() {
        on_delta(&text);
    }
    Ok(text)
}

async fn http_post_sse(
    url: &str,
    bearer: &str,
    body: &serde_json::Value,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> Result<String> {
    let (host, port, https, path) = parse_endpoint(url)?;
    let payload = serde_json::to_string(body)?;
    let req = format_request("POST", &path, &host, bearer, &payload);
    let tcp = tokio::net::TcpStream::connect((host.as_str(), port)).await?;
    if https {
        let connector = crate::imap::tls_connector();
        let server_name = rustls::pki_types::ServerName::try_from(host.clone())
            .map_err(|e| CoreError::Tls(e.to_string()))?;
        let stream = connector
            .connect(server_name, tcp)
            .await
            .map_err(|e| CoreError::Tls(e.to_string()))?;
        stream_sse(stream, &req, on_delta).await
    } else {
        stream_sse(tcp, &req, on_delta).await
    }
}

/// Read a Server-Sent-Events chat stream, invoking `on_delta` for each
/// `choices[0].delta.content` chunk. Returns the concatenated content.
/// Assumes an unchunked HTTP/1.0 body (the client always sends `Connection:
/// close`), so the body runs to EOF.
async fn stream_sse<S>(
    mut stream: S,
    req: &str,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> Result<String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    stream.write_all(req.as_bytes()).await?;

    let idle = std::time::Duration::from_secs(120);
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut header_done = false;
    let mut full = String::new();

    loop {
        let n = tokio::time::timeout(idle, stream.read(&mut chunk))
            .await
            .map_err(|_| CoreError::Other("ai stream timed out".into()))??;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);

        if !header_done {
            let Some(pos) = find_subslice(&buf, b"\r\n\r\n") else {
                continue;
            };
            let head = String::from_utf8_lossy(&buf[..pos]);
            let status = head
                .lines()
                .next()
                .and_then(|l| l.split_whitespace().nth(1))
                .unwrap_or("0");
            if !status.starts_with('2') {
                let body_txt = String::from_utf8_lossy(&buf[pos + 4..]);
                return Err(CoreError::Other(format!(
                    "ai api error {status}: {}",
                    body_txt.chars().take(400).collect::<String>()
                )));
            }
            buf.drain(..pos + 4);
            header_done = true;
        }

        // Consume whole lines; keep any trailing partial line in `buf`.
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&raw);
            let Some(data) = line.trim().strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                return Ok(full);
            }
            if data.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            if let Some(tok) = v["choices"][0]["delta"]["content"].as_str() {
                if !tok.is_empty() {
                    full.push_str(tok);
                    on_delta(tok);
                }
            }
        }
    }
    Ok(full)
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Render a thread as plain text context for prompting, newest last,
/// truncated to keep prompts bounded.
pub fn thread_context(messages: &[crate::models::MessageDetail], budget_chars: usize) -> String {
    let mut out = String::new();
    for m in messages {
        let body = m.text_body.as_deref().unwrap_or(m.snippet.as_str());
        let body: String = body.chars().take(4000).collect();
        out.push_str(&format!(
            "--- From: {} <{}> at {}\n{}\n\n",
            m.from.name.as_deref().unwrap_or(""),
            m.from.email,
            chrono::DateTime::from_timestamp_millis(m.date)
                .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_default(),
            body
        ));
    }
    if out.len() > budget_chars {
        // Keep the most recent messages (tail).
        let tail: String = out
            .chars()
            .skip(out.chars().count().saturating_sub(budget_chars))
            .collect();
        out = format!("[earlier messages truncated]\n{tail}");
    }
    out
}

/// Render retrieved messages as numbered excerpts the model can cite by index.
pub fn rag_context(messages: &[crate::models::MessageDetail], budget_chars: usize) -> String {
    let mut out = String::new();
    for (i, m) in messages.iter().enumerate() {
        let body = m.text_body.as_deref().unwrap_or(m.snippet.as_str());
        let body: String = body.chars().take(3000).collect();
        out.push_str(&format!(
            "[{}] Subject: {}\nFrom: {} <{}>  Date: {}\n{}\n\n",
            i + 1,
            m.subject,
            m.from.name.as_deref().unwrap_or(""),
            m.from.email,
            chrono::DateTime::from_timestamp_millis(m.date)
                .map(|d| d.format("%Y-%m-%d").to_string())
                .unwrap_or_default(),
            body
        ));
    }
    if out.chars().count() > budget_chars {
        out = out.chars().take(budget_chars).collect();
    }
    out
}

pub fn ask_prompt(question: &str, context: &str) -> Vec<ChatMessage> {
    vec![
        ChatMessage {
            role: "system",
            content: "You answer the user's question about their own email using ONLY the \
                      numbered email excerpts provided. Cite the excerpts you use inline like \
                      [1], [2]. If the answer is not in the excerpts, say you couldn't find it. \
                      Reply in concise plain text - no markdown, no preamble."
                .into(),
        },
        ChatMessage {
            role: "user",
            content: format!("Emails:\n\n{context}\n\nQuestion: {question}"),
        },
    ]
}

pub fn summarize_prompt(subject: &str, context: &str) -> Vec<ChatMessage> {
    vec![
        ChatMessage {
            role: "system",
            content: "You summarize email threads. Reply with 1-3 short plain-text \
                      sentences: what happened and what (if anything) needs action. \
                      No preamble, no markdown."
                .into(),
        },
        ChatMessage {
            role: "user",
            content: format!("Subject: {subject}\n\n{context}"),
        },
    ]
}

pub fn draft_prompt(
    subject: &str,
    context: &str,
    instruction: &str,
    sender_name: &str,
) -> Vec<ChatMessage> {
    vec![
        ChatMessage {
            role: "system",
            content: format!(
                "You draft email replies on behalf of {sender_name}. Write only the \
                 email body as plain text - no subject line, no markdown, no \
                 commentary. Match a concise, warm, professional tone."
            ),
        },
        ChatMessage {
            role: "user",
            content: format!(
                "Thread (subject: {subject}):\n\n{context}\n\nInstruction: {instruction}"
            ),
        },
    ]
}

/// Ask the model to distill a reusable style profile from the user's own past
/// emails. The result is stored and later prepended to voiced drafts.
pub fn voice_profile_prompt(samples: &[String]) -> Vec<ChatMessage> {
    let joined = samples
        .iter()
        .enumerate()
        .map(|(i, s)| format!("--- Email {} ---\n{}", i + 1, s.chars().take(1500).collect::<String>()))
        .collect::<Vec<_>>()
        .join("\n\n");
    vec![
        ChatMessage {
            role: "system",
            content: "You are a writing-style analyst. Given examples of one person's own \
                      emails, write a concise profile of how they write - as 5–10 short plain-text \
                      lines. Capture: how they greet and sign off, formality and warmth, typical \
                      sentence length, punctuation and emoji habits, and any recurring phrases. \
                      Describe only style, never the content. Output only the profile."
                .into(),
        },
        ChatMessage {
            role: "user",
            content: format!("Here are the person's emails:\n\n{joined}"),
        },
    ]
}

/// Voiced draft: the user's style profile in the system prompt, their most
/// relevant past (incoming → their reply) exchanges as few-shot turns, then the
/// current thread + instruction. `profile` and/or `examples` may be empty.
pub fn draft_prompt_voiced(
    subject: &str,
    context: &str,
    instruction: &str,
    sender_name: &str,
    profile: &str,
    examples: &[(String, String)],
) -> Vec<ChatMessage> {
    let mut system = format!(
        "You draft email replies on behalf of {sender_name}, closely imitating their personal \
         writing voice. Write only the email body as plain text - no subject line, no markdown, \
         no commentary."
    );
    if !profile.trim().is_empty() {
        system.push_str("\n\nTheir writing style:\n");
        system.push_str(profile.trim());
    }
    if !examples.is_empty() {
        system.push_str(
            "\n\nBelow are real past exchanges: each user message is an email they received and \
             each assistant message is how they actually replied. Match that voice.",
        );
    }

    let mut msgs = vec![ChatMessage {
        role: "system",
        content: system,
    }];
    for (incoming, reply) in examples {
        msgs.push(ChatMessage {
            role: "user",
            content: incoming.chars().take(1500).collect(),
        });
        msgs.push(ChatMessage {
            role: "assistant",
            content: reply.chars().take(1500).collect(),
        });
    }
    msgs.push(ChatMessage {
        role: "user",
        content: format!("Thread (subject: {subject}):\n\n{context}\n\nInstruction: {instruction}"),
    });
    msgs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voiced_prompt_orders_profile_fewshot_then_query() {
        let examples = vec![
            ("incoming A".to_string(), "my reply A".to_string()),
            ("incoming B".to_string(), "my reply B".to_string()),
        ];
        let msgs = draft_prompt_voiced(
            "Re: lunch",
            "context here",
            "say yes",
            "Dana",
            "- brief and warm\n- signs 'Cheers'",
            &examples,
        );
        // system, then (user,assistant) x2, then final user = 6 messages.
        assert_eq!(msgs.len(), 6);
        assert_eq!(msgs[0].role, "system");
        assert!(msgs[0].content.contains("Dana"));
        assert!(msgs[0].content.contains("signs 'Cheers'"));
        assert_eq!(msgs[1].role, "user");
        assert_eq!(msgs[1].content, "incoming A");
        assert_eq!(msgs[2].role, "assistant");
        assert_eq!(msgs[2].content, "my reply A");
        assert_eq!(msgs[5].role, "user");
        assert!(msgs[5].content.contains("say yes"));
        assert!(msgs[5].content.contains("Re: lunch"));
    }

    #[test]
    fn voiced_prompt_without_examples_or_profile() {
        let msgs = draft_prompt_voiced("S", "C", "do it", "Dana", "", &[]);
        assert_eq!(msgs.len(), 2); // system + final user only
        assert_eq!(msgs[0].role, "system");
        assert!(!msgs[0].content.contains("Their writing style"));
    }
}
