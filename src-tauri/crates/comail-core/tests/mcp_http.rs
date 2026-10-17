//! End-to-end MCP over HTTP: start a real Core with the server enabled, then
//! speak JSON-RPC to it the way Claude Code / Cursor would.

use comail_core::Core;
use comail_core::config::Paths;
use serde_json::{Value, json};

async fn rpc(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    body: Value,
) -> (reqwest::StatusCode, Option<String>, Value) {
    let resp = http
        .post(url)
        .bearer_auth(token)
        .header("accept", "application/json, text/event-stream")
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap();
    let status = resp.status();
    let session = resp
        .headers()
        .get("mcp-session-id")
        .map(|v| v.to_str().unwrap().to_string());
    let text = resp.text().await.unwrap();
    (
        status,
        session,
        serde_json::from_str(&text).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn mcp_server_speaks_json_rpc() {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    // Keep the token out of the developer's real keyring.
    // SAFETY: set before any other thread reads the environment.
    unsafe {
        std::env::set_var(
            "COMAIL_CREDENTIALS_INSECURE_FILE",
            tmp.path().join("creds.json"),
        );
    }
    let core = Core::start(Paths::for_tests(&data_dir)).await.unwrap();
    core.db
        .write(|conn| {
            conn.execute_batch(
                "INSERT INTO accounts
                   (id,email,provider,auth_kind,username,imap_host,imap_port,smtp_host,smtp_port,created_at)
                   VALUES (1,'me@example.com','imap','password','me','h',993,'h',465,0);
                 INSERT INTO folders (id,account_id,imap_name,role)
                   VALUES (1,1,'Drafts','drafts');",
            )?;
            Ok(())
        })
        .await
        .unwrap();

    // Grab a free port, then hand it to the server.
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut settings = core.get_settings().await.unwrap();
    settings.mcp_enabled = true;
    settings.mcp_port = port;
    settings.mcp_instructions = "Always sign emails as Dean.".into();
    core.set_settings(settings.clone()).await.unwrap();
    let status = core.mcp_status().await.unwrap();
    assert!(status.running, "server not running: {:?}", status.error);

    let url = status.url.clone();
    let token = core.mcp_token().await.unwrap();
    let http = reqwest::Client::new();

    // Auth: no token, wrong token, foreign Origin.
    let r = http.post(&url).body("{}").send().await.unwrap();
    assert_eq!(r.status(), 401);
    let (s, _, _) = rpc(&http, &url, "nope", json!({})).await;
    assert_eq!(s, 401);
    let r = http
        .post(&url)
        .bearer_auth(&token)
        .header("origin", "https://evil.example")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);

    // initialize -> session id + capabilities.
    let (s, session, v) = rpc(
        &http,
        &url,
        &token,
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "test-client", "version": "1" }
            }
        }),
    )
    .await;
    assert_eq!(s, 200);
    assert!(session.is_some());
    assert_eq!(v["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(v["result"]["serverInfo"]["name"], "comail");
    let instructions = v["result"]["instructions"].as_str().unwrap();
    assert!(instructions.contains("1: me@example.com"), "{instructions}");
    assert!(instructions.contains("send: turned off by the user"));
    assert!(instructions.contains("Always sign emails as Dean."));

    // Prompts: listed, and filled in on get.
    let (_, _, v) = rpc(
        &http,
        &url,
        &token,
        json!({ "jsonrpc": "2.0", "id": 10, "method": "prompts/list" }),
    )
    .await;
    assert!(
        v["result"]["prompts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == "catch_up")
    );
    let (_, _, v) = rpc(
        &http,
        &url,
        &token,
        json!({
            "jsonrpc": "2.0", "id": 11, "method": "prompts/get",
            "params": { "name": "find_email", "arguments": { "description": "the lease" } }
        }),
    )
    .await;
    assert!(
        v["result"]["messages"][0]["content"]["text"]
            .as_str()
            .unwrap()
            .contains("Find this email: the lease.")
    );

    // Notifications get 202 with no body.
    let (s, _, _) = rpc(
        &http,
        &url,
        &token,
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await;
    assert_eq!(s, 202);

    // tools/list honors permissions.
    let (_, _, v) = rpc(
        &http,
        &url,
        &token,
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    )
    .await;
    let names: Vec<&str> = v["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"search_emails"));
    assert!(names.contains(&"create_draft"));
    assert!(!names.contains(&"send_draft"));

    // tools/call: create a draft, then find it.
    let (_, _, v) = rpc(
        &http,
        &url,
        &token,
        json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "create_draft", "arguments": {
                "to": ["Ada <ada@example.com>"], "subject": "Lunch", "body": "Tuesday?"
            }}
        }),
    )
    .await;
    assert_eq!(v["result"]["isError"], false, "{v}");
    let out: Value =
        serde_json::from_str(v["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert!(out["draft_id"].as_i64().is_some());

    // A gated tool is refused as a tool error the model can read.
    let (_, _, v) = rpc(
        &http,
        &url,
        &token,
        json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "send_draft", "arguments": { "draft_id": out["draft_id"] } }
        }),
    )
    .await;
    assert_eq!(v["result"]["isError"], true);

    // Unknown tool is a protocol error.
    let (_, _, v) = rpc(
        &http,
        &url,
        &token,
        json!({
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": { "name": "nope", "arguments": {} }
        }),
    )
    .await;
    assert_eq!(v["error"]["code"], -32602);

    // Token in the path works for header-less clients.
    let (s, _, v) = rpc(
        &http,
        &format!("{url}/{token}"),
        "",
        json!({ "jsonrpc": "2.0", "id": 6, "method": "ping" }),
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(v["result"], json!({}));

    // Activity log saw the calls.
    let activity = core.mcp_activity();
    assert!(activity.iter().any(|c| c.tool == "create_draft" && c.ok));

    // Turning it off stops the server.
    settings.mcp_enabled = false;
    core.set_settings(settings).await.unwrap();
    assert!(!core.mcp_status().await.unwrap().running);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(http.post(&url).send().await.is_err());
}
