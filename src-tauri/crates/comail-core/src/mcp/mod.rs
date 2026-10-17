//! Local MCP (Model Context Protocol) server, so AI clients (Claude Code,
//! Claude Desktop, Cursor, VS Code, Codex, ...) can search, read and draft
//! mail through the running app.
//!
//! Transport is MCP "Streamable HTTP" bound to 127.0.0.1 only. We answer every
//! request with a plain `application/json` body (the spec lets a server skip
//! SSE when it never streams), so the protocol surface is small: initialize,
//! ping, tools/list, tools/call. Tools run against the live `Core`, so there
//! is no second sync and the in-memory semantic index is available.
//!
//! Auth: a random bearer token kept in the OS keyring. Clients that can't send
//! headers may put it in the path instead (`/mcp/<token>`). Requests whose
//! Origin or Host isn't loopback are refused (DNS-rebinding protection).

pub mod clients;
mod guide;
mod tools;

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::Core;
use crate::accounts::credentials::{self, Slot};
use crate::error::{CoreError, Result};
use crate::events::CoreEvent;
use crate::models::now_ms;

pub const DEFAULT_PORT: u16 = 47823;
const SERVER_NAME: &str = "comail";
/// Newest first; we echo the client's version when we know it.
const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const ACTIVITY_CAP: usize = 200;

/// One tool call, for the settings panel's "Recent activity" list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCall {
    pub at: i64,
    pub client: String,
    pub tool: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
    pub url: String,
    pub error: Option<String>,
    /// Distinct clients that initialized a session since the server started.
    pub client_count: usize,
}

struct Running {
    port: u16,
    shutdown: oneshot::Sender<()>,
}

/// Owned by `Core`; holds the server task, the cached token and the activity log.
#[derive(Default)]
pub struct McpManager {
    running: tokio::sync::Mutex<Option<Running>>,
    error: Mutex<Option<String>>,
    token: Mutex<Option<String>>,
    activity: Mutex<VecDeque<McpCall>>,
    /// Session id -> client name from `initialize`.
    sessions: Mutex<HashMap<String, String>>,
}

pub fn url_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

fn new_token() -> String {
    use base64::Engine;
    let bytes: [u8; 32] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

impl Core {
    /// Start, stop or restart the server to match the saved settings. Called at
    /// startup and after every settings save; a no-op when nothing changed.
    pub async fn mcp_apply_settings(&self) -> Result<()> {
        let settings = self.get_settings().await?;
        let port = if settings.mcp_port == 0 {
            DEFAULT_PORT
        } else {
            settings.mcp_port
        };
        let mut running = self.mcp.running.lock().await;
        if settings.mcp_enabled && running.as_ref().map(|r| r.port) == Some(port) {
            return Ok(());
        }
        if let Some(r) = running.take() {
            let _ = r.shutdown.send(());
            self.mcp.sessions.lock().unwrap().clear();
        }
        *self.mcp.error.lock().unwrap() = None;
        if !settings.mcp_enabled {
            return Ok(());
        }
        let token = self.mcp_token().await?;
        let listener =
            match tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await {
                Ok(l) => l,
                Err(e) => {
                    let msg = format!("could not listen on 127.0.0.1:{port}: {e}");
                    tracing::warn!("mcp: {msg}");
                    *self.mcp.error.lock().unwrap() = Some(msg);
                    return Ok(());
                }
            };
        let ctx = Arc::new(Ctx {
            core: self.clone(),
            token,
        });
        let app = Router::new()
            .route("/mcp", any(handle_header_auth))
            .route("/mcp/{token}", any(handle_path_auth))
            .with_state(ctx);
        let (tx, rx) = oneshot::channel::<()>();
        let mcp = self.mcp.clone();
        tokio::spawn(async move {
            let served = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await;
            if let Err(e) = served {
                tracing::warn!("mcp: server stopped: {e}");
                *mcp.error.lock().unwrap() = Some(e.to_string());
            }
        });
        tracing::info!("mcp: listening on {}", url_for(port));
        *running = Some(Running { port, shutdown: tx });
        Ok(())
    }

    pub async fn mcp_status(&self) -> Result<McpStatus> {
        let settings = self.get_settings().await?;
        let running = self.mcp.running.lock().await;
        let port = running
            .as_ref()
            .map(|r| r.port)
            .unwrap_or(if settings.mcp_port == 0 {
                DEFAULT_PORT
            } else {
                settings.mcp_port
            });
        let client_count = {
            let sessions = self.mcp.sessions.lock().unwrap();
            let mut names: Vec<&String> = sessions.values().collect();
            names.sort();
            names.dedup();
            names.len()
        };
        Ok(McpStatus {
            running: running.is_some(),
            port,
            url: url_for(port),
            error: self.mcp.error.lock().unwrap().clone(),
            client_count,
        })
    }

    /// The bearer token, created (and stored in the keyring) on first use.
    pub async fn mcp_token(&self) -> Result<String> {
        if let Some(t) = self.mcp.token.lock().unwrap().clone() {
            return Ok(t);
        }
        let token = match credentials::load_async(0, Slot::McpToken).await {
            Ok(t) if !t.is_empty() => t,
            _ => {
                let t = new_token();
                credentials::store_async(0, Slot::McpToken, t.clone()).await?;
                t
            }
        };
        *self.mcp.token.lock().unwrap() = Some(token.clone());
        Ok(token)
    }

    /// Replace the token. Every client configured with the old one stops
    /// working until it is added again.
    pub async fn mcp_regenerate_token(&self) -> Result<String> {
        let token = new_token();
        credentials::store_async(0, Slot::McpToken, token.clone()).await?;
        *self.mcp.token.lock().unwrap() = Some(token.clone());
        // Restart so the running server checks the new token.
        if let Some(r) = self.mcp.running.lock().await.take() {
            let _ = r.shutdown.send(());
        }
        self.mcp_apply_settings().await?;
        Ok(token)
    }

    pub fn mcp_activity(&self) -> Vec<McpCall> {
        self.mcp
            .activity
            .lock()
            .unwrap()
            .iter()
            .rev()
            .cloned()
            .collect()
    }

    fn mcp_record(&self, call: McpCall) {
        {
            let mut log = self.mcp.activity.lock().unwrap();
            if log.len() >= ACTIVITY_CAP {
                log.pop_front();
            }
            log.push_back(call.clone());
        }
        self.bus.emit(CoreEvent::McpActivity(call));
    }
}

struct Ctx {
    core: Core,
    token: String,
}

async fn handle_header_auth(
    State(ctx): State<Arc<Ctx>>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let presented = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        })
        .map(str::trim)
        .unwrap_or("");
    let ok = token_eq(presented, &ctx.token);
    handle(ctx, ok, method, headers, body).await
}

async fn handle_path_auth(
    State(ctx): State<Arc<Ctx>>,
    Path(token): Path<String>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let ok = token_eq(&token, &ctx.token);
    handle(ctx, ok, method, headers, body).await
}

/// Constant-time so the token can't be recovered byte by byte from timing.
fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// True for a Host/Origin that names this machine. A browser page on another
/// site that resolves its own hostname to 127.0.0.1 (DNS rebinding) still
/// sends its own name here, so it is refused.
fn is_loopback_authority(value: &str) -> bool {
    let rest = value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"))
        .unwrap_or(value);
    let authority = rest.split('/').next().unwrap_or("");
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    matches!(
        host.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1"
    )
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

async fn handle(
    ctx: Arc<Ctx>,
    authed: bool,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
        if origin != "null" && !is_loopback_authority(origin) {
            return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
        }
    }
    if let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) {
        if !is_loopback_authority(host) {
            return (StatusCode::FORBIDDEN, "host not allowed").into_response();
        }
    }
    if !authed {
        return (
            StatusCode::UNAUTHORIZED,
            "missing or invalid comail MCP token",
        )
            .into_response();
    }
    let session = headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    match method {
        Method::POST => {}
        Method::DELETE => {
            if let Some(s) = session {
                ctx.core.mcp.sessions.lock().unwrap().remove(&s);
            }
            return StatusCode::OK.into_response();
        }
        // No server-initiated stream: GET has nothing to offer.
        _ => return StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }

    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(rpc_error(Value::Null, -32700, "parse error")),
            )
                .into_response();
        }
    };

    let mut new_session: Option<String> = None;
    let (out, any_request) = match parsed {
        Value::Array(batch) => {
            let mut replies = Vec::new();
            for msg in batch {
                if let Some(r) = dispatch(&ctx, msg, session.as_deref(), &mut new_session).await {
                    replies.push(r);
                }
            }
            let any = !replies.is_empty();
            (Value::Array(replies), any)
        }
        msg => match dispatch(&ctx, msg, session.as_deref(), &mut new_session).await {
            Some(r) => (r, true),
            None => (Value::Null, false),
        },
    };

    let mut resp = if any_request {
        axum::Json(out).into_response()
    } else {
        // Notifications and client responses only.
        StatusCode::ACCEPTED.into_response()
    };
    if let Some(s) = new_session {
        if let Ok(v) = HeaderValue::from_str(&s) {
            resp.headers_mut().insert("mcp-session-id", v);
        }
    }
    resp
}

/// Handle one JSON-RPC message; None for notifications (no reply).
async fn dispatch(
    ctx: &Ctx,
    msg: Value,
    session: Option<&str>,
    new_session: &mut Option<String>,
) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    // Notifications (no id) and responses to our (nonexistent) requests.
    let id = match id {
        Some(id) if !method.is_empty() => id,
        _ => return None,
    };
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let requested = params["protocolVersion"].as_str().unwrap_or("");
            let version = PROTOCOL_VERSIONS
                .iter()
                .find(|v| **v == requested)
                .copied()
                .unwrap_or(PROTOCOL_VERSIONS[1]);
            let client = params["clientInfo"]["name"]
                .as_str()
                .unwrap_or("unknown client")
                .to_string();
            let settings = ctx.core.get_settings().await.unwrap_or_default();
            let instructions = guide::instructions(&ctx.core, &settings).await;
            let sid = format!("{}{}", now_ms(), crate::mime::rand_token());
            ctx.core
                .mcp
                .sessions
                .lock()
                .unwrap()
                .insert(sid.clone(), client);
            *new_session = Some(sid);
            Ok(json!({
                "protocolVersion": version,
                "capabilities": {
                    "tools": { "listChanged": false },
                    "prompts": { "listChanged": false },
                },
                "serverInfo": {
                    "name": SERVER_NAME,
                    "title": "comail",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "instructions": instructions,
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => match ctx.core.get_settings().await {
            Ok(settings) => Ok(json!({ "tools": tools::list(&settings) })),
            Err(e) => Err((-32603, e.to_string())),
        },
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or("").to_string();
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let client = session
                .and_then(|s| ctx.core.mcp.sessions.lock().unwrap().get(s).cloned())
                .unwrap_or_else(|| "unknown client".into());
            let outcome = tools::call(&ctx.core, &name, args).await;
            ctx.core.mcp_record(McpCall {
                at: now_ms(),
                client,
                tool: name.clone(),
                ok: outcome.is_ok(),
                error: outcome.as_ref().err().cloned(),
            });
            // Tool failures are results with isError, so the model can read
            // and recover from them; only an unknown tool is a protocol error.
            match outcome {
                Ok(text) => Ok(json!({
                    "content": [{ "type": "text", "text": text }],
                    "isError": false,
                })),
                Err(e) if e.starts_with(tools::UNKNOWN_TOOL) => Err((-32602, e)),
                Err(e) => Ok(json!({
                    "content": [{ "type": "text", "text": e }],
                    "isError": true,
                })),
            }
        }
        "resources/list" => Ok(json!({ "resources": [] })),
        "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
        "prompts/list" => Ok(json!({ "prompts": guide::list_prompts() })),
        "prompts/get" => {
            let name = params["name"].as_str().unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            guide::get_prompt(name, &args).map_err(|e| (-32602, e))
        }
        _ => Err((-32601, format!("method not found: {method}"))),
    };
    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err((code, message)) => rpc_error(id, code, &message),
    })
}

impl From<CoreError> for String {
    fn from(e: CoreError) -> Self {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_authorities() {
        assert!(is_loopback_authority("127.0.0.1:47823"));
        assert!(is_loopback_authority("localhost"));
        assert!(is_loopback_authority("http://localhost:5173"));
        assert!(is_loopback_authority("[::1]:47823"));
        assert!(!is_loopback_authority("evil.example:47823"));
        assert!(!is_loopback_authority("https://127.0.0.1.evil.example"));
    }

    #[test]
    fn token_compare() {
        assert!(token_eq("abc", "abc"));
        assert!(!token_eq("abd", "abc"));
        assert!(!token_eq("ab", "abc"));
        assert!(!token_eq("", ""));
    }
}
