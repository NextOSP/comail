//! "Add to <AI app>" quick setup. Each client gets one of four methods:
//! - `command`: run the client's own CLI (Claude Code),
//! - `deeplink`: open the client's install URL (Cursor, VS Code, LM Studio),
//! - `write`: merge a `comail` entry into the client's config file,
//! - `copy`: show a snippet the user pastes (configs we can't safely edit).
//!
//! Config writes touch only the `comail` key and back the file up to
//! `<file>.bak` first. A file we can't parse (e.g. JSON with comments) is never
//! rewritten; the user gets the snippet instead.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Value, json};

use crate::Core;
use crate::error::{CoreError, Result};

const KEY: &str = "comail";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    Command,
    Deeplink,
    Write,
    Copy,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub method: Method,
    /// The app or its config dir exists on this machine.
    pub detected: bool,
    /// Where `write` puts the entry, for display.
    pub config_path: Option<String>,
    /// Snippet language for the copy view: "json" | "toml" | "yaml" | "shell" | "text".
    pub snippet_lang: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub ok: bool,
    pub message: String,
    pub path: Option<String>,
    /// A deep link the host should open (the core is Tauri-free).
    pub open_url: Option<String>,
}

/// Connection details every snippet is built from.
pub struct Conn {
    pub url: String,
    pub token: String,
}

impl Conn {
    fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }
    fn headers(&self) -> Value {
        json!({ "Authorization": self.auth() })
    }
}

#[derive(Clone, Copy)]
struct Client {
    id: &'static str,
    name: &'static str,
    method: Method,
    lang: &'static str,
}

const CLIENTS: &[Client] = &[
    Client {
        id: "claude-code",
        name: "Claude Code",
        method: Method::Command,
        lang: "shell",
    },
    Client {
        id: "claude-desktop",
        name: "Claude Desktop",
        method: Method::Write,
        lang: "json",
    },
    Client {
        id: "cursor",
        name: "Cursor",
        method: Method::Deeplink,
        lang: "json",
    },
    Client {
        id: "vscode",
        name: "VS Code",
        method: Method::Deeplink,
        lang: "json",
    },
    Client {
        id: "vscode-insiders",
        name: "VS Code Insiders",
        method: Method::Deeplink,
        lang: "json",
    },
    Client {
        id: "windsurf",
        name: "Windsurf",
        method: Method::Write,
        lang: "json",
    },
    Client {
        id: "codex",
        name: "Codex CLI",
        method: Method::Write,
        lang: "toml",
    },
    Client {
        id: "gemini",
        name: "Gemini CLI",
        method: Method::Write,
        lang: "json",
    },
    Client {
        id: "opencode",
        name: "opencode",
        method: Method::Write,
        lang: "json",
    },
    Client {
        id: "lmstudio",
        name: "LM Studio",
        method: Method::Deeplink,
        lang: "json",
    },
    Client {
        id: "zed",
        name: "Zed",
        method: Method::Copy,
        lang: "json",
    },
    Client {
        id: "cline",
        name: "Cline",
        method: Method::Copy,
        lang: "json",
    },
    Client {
        id: "continue",
        name: "Continue",
        method: Method::Copy,
        lang: "yaml",
    },
    Client {
        id: "goose",
        name: "Goose",
        method: Method::Copy,
        lang: "yaml",
    },
    Client {
        id: "chatgpt",
        name: "ChatGPT",
        method: Method::Copy,
        lang: "text",
    },
    Client {
        id: "generic",
        name: "Other MCP client",
        method: Method::Copy,
        lang: "json",
    },
];

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

/// Per-OS application support dir (`~/Library/Application Support`,
/// `%APPDATA%`, `~/.config`).
fn app_config_dir(name: &str) -> PathBuf {
    dirs::config_dir().unwrap_or_else(home).join(name)
}

fn config_path(id: &str) -> Option<PathBuf> {
    let h = home();
    Some(match id {
        "claude-desktop" => app_config_dir("Claude").join("claude_desktop_config.json"),
        "cursor" => h.join(".cursor").join("mcp.json"),
        "windsurf" => h.join(".codeium").join("windsurf").join("mcp_config.json"),
        "codex" => std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| h.join(".codex"))
            .join("config.toml"),
        "gemini" => h.join(".gemini").join("settings.json"),
        "opencode" => h.join(".config").join("opencode").join("opencode.json"),
        "lmstudio" => h.join(".lmstudio").join("mcp.json"),
        _ => return None,
    })
}

/// Dirs whose existence means the client is installed / has been run.
fn detect_paths(id: &str) -> Vec<PathBuf> {
    let h = home();
    match id {
        "claude-code" => vec![h.join(".claude")],
        "claude-desktop" => vec![
            app_config_dir("Claude"),
            PathBuf::from("/Applications/Claude.app"),
        ],
        "cursor" => vec![h.join(".cursor"), PathBuf::from("/Applications/Cursor.app")],
        "vscode" => vec![
            app_config_dir("Code"),
            PathBuf::from("/Applications/Visual Studio Code.app"),
        ],
        "vscode-insiders" => vec![app_config_dir("Code - Insiders")],
        "windsurf" => vec![
            h.join(".codeium").join("windsurf"),
            PathBuf::from("/Applications/Windsurf.app"),
        ],
        "codex" => vec![h.join(".codex")],
        "gemini" => vec![h.join(".gemini")],
        "opencode" => vec![h.join(".config").join("opencode")],
        "lmstudio" => vec![
            h.join(".lmstudio"),
            PathBuf::from("/Applications/LM Studio.app"),
        ],
        "zed" => vec![
            h.join(".config").join("zed"),
            PathBuf::from("/Applications/Zed.app"),
        ],
        "cline" => vec![
            app_config_dir("Code")
                .join("User")
                .join("globalStorage")
                .join("saoudrizwan.claude-dev"),
        ],
        "continue" => vec![h.join(".continue")],
        "goose" => vec![h.join(".config").join("goose")],
        "chatgpt" => vec![PathBuf::from("/Applications/ChatGPT.app")],
        _ => Vec::new(),
    }
}

/// Find an executable the way a login shell would. GUI apps on macOS start
/// with a bare PATH, so the usual install locations are checked as well.
pub fn find_executable(name: &str) -> Option<PathBuf> {
    let h = home();
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend([
        h.join(".claude").join("local"),
        h.join(".local").join("bin"),
        h.join(".npm-global").join("bin"),
        h.join(".volta").join("bin"),
        h.join(".bun").join("bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ]);
    // nvm keeps one bin dir per installed Node.
    if let Ok(entries) = std::fs::read_dir(h.join(".nvm").join("versions").join("node")) {
        let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path().join("bin")).collect();
        versions.sort();
        dirs.extend(versions.into_iter().rev());
    }
    let names: Vec<String> = if cfg!(windows) {
        vec![
            format!("{name}.cmd"),
            format!("{name}.exe"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };
    dirs.iter()
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
}

fn find(id: &str) -> Result<Client> {
    CLIENTS
        .iter()
        .find(|c| c.id == id)
        .copied()
        .ok_or_else(|| CoreError::NotFound(format!("MCP client {id}")))
}

/// `/Users/me/.codex/config.toml` -> `~/.codex/config.toml`, for display.
fn tilde(p: &Path) -> String {
    match p.strip_prefix(home()) {
        Ok(rest) if !home().as_os_str().is_empty() => format!("~/{}", rest.to_string_lossy()),
        _ => p.to_string_lossy().into_owned(),
    }
}

pub fn list() -> Vec<ClientInfo> {
    CLIENTS
        .iter()
        .map(|c| ClientInfo {
            id: c.id,
            name: c.name,
            method: c.method,
            detected: match c.id {
                "claude-code" => {
                    find_executable("claude").is_some()
                        || detect_paths(c.id).iter().any(|p| p.exists())
                }
                _ => detect_paths(c.id).iter().any(|p| p.exists()),
            },
            config_path: config_path(c.id).map(|p| tilde(&p)),
            snippet_lang: c.lang,
        })
        .collect()
}

/// The entry for clients that only speak stdio (Claude Desktop's config file):
/// `mcp-remote` bridges stdio to our HTTP endpoint. The header goes through an
/// env var because some platforms mangle spaces inside args.
fn stdio_bridge(conn: &Conn) -> Value {
    let npx = find_executable("npx")
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "npx".into());
    json!({
        "command": npx,
        "args": ["-y", "mcp-remote", conn.url, "--header", "Authorization:${COMAIL_MCP_AUTH}"],
        "env": { "COMAIL_MCP_AUTH": conn.auth() },
    })
}

/// (path inside the config, entry) for JSON-config clients.
fn json_entry(id: &str, conn: &Conn) -> Option<(&'static [&'static str], Value)> {
    Some(match id {
        "claude-desktop" => (&["mcpServers"], stdio_bridge(conn)),
        "cursor" | "lmstudio" => (
            &["mcpServers"],
            json!({ "url": conn.url, "headers": conn.headers() }),
        ),
        "windsurf" => (
            &["mcpServers"],
            json!({ "serverUrl": conn.url, "headers": conn.headers() }),
        ),
        "gemini" => (
            &["mcpServers"],
            json!({ "httpUrl": conn.url, "headers": conn.headers() }),
        ),
        "opencode" => (
            &["mcp"],
            json!({ "type": "remote", "url": conn.url, "headers": conn.headers(), "enabled": true }),
        ),
        "vscode" | "vscode-insiders" => (
            &["servers"],
            json!({ "type": "http", "url": conn.url, "headers": conn.headers() }),
        ),
        "zed" => (
            &["context_servers"],
            json!({ "url": conn.url, "headers": conn.headers() }),
        ),
        "cline" => (
            &["mcpServers"],
            json!({ "type": "streamableHttp", "url": conn.url, "headers": conn.headers(), "disabled": false }),
        ),
        "generic" => (
            &["mcpServers"],
            json!({ "type": "http", "url": conn.url, "headers": conn.headers() }),
        ),
        _ => return None,
    })
}

fn wrap(path: &[&str], entry: Value) -> Value {
    let mut v = json!({ KEY: entry });
    for key in path.iter().rev() {
        v = json!({ *key: v });
    }
    v
}

fn claude_code_args(conn: &Conn) -> Vec<String> {
    vec![
        "mcp".into(),
        "add".into(),
        "--transport".into(),
        "http".into(),
        "--scope".into(),
        "user".into(),
        KEY.into(),
        conn.url.clone(),
        "--header".into(),
        format!("Authorization: {}", conn.auth()),
    ]
}

fn codex_toml(conn: &Conn) -> String {
    format!(
        "[mcp_servers.{KEY}]\nurl = \"{}\"\nhttp_headers = {{ \"Authorization\" = \"{}\" }}\n",
        conn.url,
        conn.auth()
    )
}

/// The text shown in "Show config" (and copied).
pub fn snippet(id: &str, conn: &Conn) -> Result<String> {
    find(id)?;
    let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap_or_default();
    Ok(match id {
        "claude-code" => {
            let args = claude_code_args(conn);
            let quoted: Vec<String> = args
                .iter()
                .map(|a| {
                    if a.contains(' ') {
                        format!("\"{a}\"")
                    } else {
                        a.clone()
                    }
                })
                .collect();
            format!("claude {}", quoted.join(" "))
        }
        "codex" => codex_toml(conn),
        "continue" => format!(
            "# ~/.continue/config.yaml\nmcpServers:\n  - name: {KEY}\n    type: streamable-http\n    url: {}\n    requestOptions:\n      headers:\n        Authorization: {}\n",
            conn.url,
            conn.auth()
        ),
        "goose" => format!(
            "# ~/.config/goose/config.yaml\nextensions:\n  {KEY}:\n    name: {KEY}\n    type: streamable_http\n    uri: {}\n    headers:\n      Authorization: {}\n    enabled: true\n    timeout: 300\n",
            conn.url,
            conn.auth()
        ),
        "chatgpt" => {
            let path_url = format!("{}/{}", conn.url, conn.token);
            format!(
                "ChatGPT connects to MCP servers from OpenAI's cloud, so it cannot reach \
                 comail on this computer directly.\n\n\
                 To use comail from ChatGPT:\n\
                 1. Expose comail through a tunnel, e.g.\n   \
                 cloudflared tunnel --url http://127.0.0.1:{port}\n\
                 2. In ChatGPT: Settings > Apps & Connectors > Advanced > turn on Developer mode, \
                 then Create a connector.\n\
                 3. Use the tunnel's https address with the token path, e.g.\n   \
                 https://<your-tunnel>{path}\n   \
                 and choose \"No authentication\" (the token in the URL is the password).\n\n\
                 Warning: anyone with that URL can read your mail while the tunnel runs. \
                 Stop the tunnel when you're done and regenerate the token in comail \
                 if the URL was shared.\n\nLocal URL with token: {path_url}\n",
                port = conn
                    .url
                    .rsplit(':')
                    .next()
                    .unwrap_or("")
                    .trim_end_matches("/mcp"),
                path = format!("/mcp/{}", conn.token),
            )
        }
        "vscode" | "vscode-insiders" => {
            let (_, entry) = json_entry(id, conn).expect("vscode entry");
            format!(
                "// VS Code: Command Palette > MCP: Open User Configuration\n{}",
                pretty(&wrap(&["servers"], entry))
            )
        }
        "zed" => {
            let (_, entry) = json_entry(id, conn).expect("zed entry");
            format!(
                "// Zed settings.json\n{}",
                pretty(&wrap(&["context_servers"], entry))
            )
        }
        _ => {
            let (path, entry) = json_entry(id, conn).expect("json client");
            pretty(&wrap(path, entry))
        }
    })
}

fn deeplink(id: &str, conn: &Conn) -> Option<String> {
    use base64::Engine;
    let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    let config = json!({ "url": conn.url, "headers": conn.headers() }).to_string();
    let b64 = base64::engine::general_purpose::STANDARD.encode(config.as_bytes());
    Some(match id {
        "cursor" => format!(
            "cursor://anysphere.cursor-deeplink/mcp/install?name={KEY}&config={}",
            enc(&b64)
        ),
        "vscode" | "vscode-insiders" => {
            let scheme = if id == "vscode" {
                "vscode"
            } else {
                "vscode-insiders"
            };
            let cfg =
                json!({ "name": KEY, "type": "http", "url": conn.url, "headers": conn.headers() });
            format!("{scheme}:mcp/install?{}", enc(&cfg.to_string()))
        }
        "lmstudio" => format!("lmstudio://add_mcp?name={KEY}&config={}", enc(&b64)),
        _ => return None,
    })
}

/// Merge `entry` at `path.KEY` into a JSON config, keeping everything else.
pub(crate) fn merge_json_config(file: &Path, path: &[&str], entry: Value) -> Result<()> {
    let mut root: Value = match std::fs::read_to_string(file) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s).map_err(|_| {
            CoreError::Other(format!(
                "{} isn't plain JSON (it may contain comments); add the snippet by hand",
                file.display()
            ))
        })?,
        Ok(_) => json!({}),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e.into()),
    };
    let mut node = &mut root;
    for key in path {
        let obj = node
            .as_object_mut()
            .ok_or_else(|| CoreError::Other(format!("unexpected shape in {}", file.display())))?;
        node = obj.entry(key.to_string()).or_insert_with(|| json!({}));
    }
    node.as_object_mut()
        .ok_or_else(|| CoreError::Other(format!("unexpected shape in {}", file.display())))?
        .insert(KEY.into(), entry);
    write_with_backup(file, &(serde_json::to_string_pretty(&root)? + "\n"))
}

pub(crate) fn merge_codex_config(file: &Path, conn: &Conn) -> Result<()> {
    let existing = match std::fs::read_to_string(file) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let mut doc: toml_edit::DocumentMut = existing
        .parse()
        .map_err(|e| CoreError::Other(format!("{} isn't valid TOML: {e}", file.display())))?;
    let servers = doc
        .entry("mcp_servers")
        .or_insert_with(|| {
            let mut t = toml_edit::Table::new();
            t.set_implicit(true);
            toml_edit::Item::Table(t)
        })
        .as_table_mut()
        .ok_or_else(|| CoreError::Other("mcp_servers in Codex config isn't a table".into()))?;
    let mut entry = toml_edit::Table::new();
    entry["url"] = toml_edit::value(conn.url.clone());
    let mut headers = toml_edit::InlineTable::new();
    headers.insert("Authorization", conn.auth().into());
    entry["http_headers"] = toml_edit::value(headers);
    servers.insert(KEY, toml_edit::Item::Table(entry));
    write_with_backup(file, &doc.to_string())
}

fn write_with_backup(file: &Path, contents: &str) -> Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if file.exists() {
        let mut bak = file.as_os_str().to_owned();
        bak.push(".bak");
        std::fs::copy(file, PathBuf::from(bak))?;
    }
    // Write-then-rename so a crash never leaves a half-written config.
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".comail-tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, file)?;
    Ok(())
}

fn ok(message: impl Into<String>, path: Option<&Path>) -> InstallResult {
    InstallResult {
        ok: true,
        message: message.into(),
        path: path.map(|p| p.to_string_lossy().into_owned()),
        open_url: None,
    }
}

fn install(id: &str, conn: &Conn) -> Result<InstallResult> {
    let client = find(id)?;
    match client.method {
        Method::Copy => Ok(InstallResult {
            ok: false,
            message: "Copy the config into the app".into(),
            path: None,
            open_url: None,
        }),
        Method::Deeplink => Ok(InstallResult {
            ok: true,
            message: format!("Opening {} to confirm", client.name),
            path: None,
            open_url: deeplink(id, conn),
        }),
        Method::Command => {
            let claude = find_executable("claude").ok_or_else(|| {
                CoreError::NotFound(
                    "the `claude` command; copy the command and run it in a terminal".into(),
                )
            })?;
            // Re-adding replaces an entry with a stale token.
            let _ = std::process::Command::new(&claude)
                .args(["mcp", "remove", "--scope", "user", KEY])
                .output();
            let out = std::process::Command::new(&claude)
                .args(claude_code_args(conn))
                .output()?;
            if out.status.success() {
                Ok(ok(
                    "Added to Claude Code. Start a new session to use it.",
                    None,
                ))
            } else {
                let err = String::from_utf8_lossy(&out.stderr);
                let out_txt = String::from_utf8_lossy(&out.stdout);
                Err(CoreError::Other(format!(
                    "claude mcp add failed: {}",
                    if err.trim().is_empty() {
                        out_txt.trim()
                    } else {
                        err.trim()
                    }
                )))
            }
        }
        Method::Write => {
            let file = config_path(id).expect("write clients have a config path");
            if id == "codex" {
                merge_codex_config(&file, conn)?;
            } else {
                let (path, entry) = json_entry(id, conn).expect("json client");
                merge_json_config(&file, path, entry)?;
            }
            let message = match id {
                "claude-desktop" if find_executable("npx").is_none() => {
                    "Added. Claude Desktop needs Node.js (npx) for this; install it, then restart Claude."
                }
                "claude-desktop" => "Added. Quit and reopen Claude Desktop to load it.",
                _ => "Added. Restart the app if it's already open.",
            };
            Ok(ok(message, Some(&file)))
        }
    }
}

impl Core {
    async fn mcp_conn(&self) -> Result<Conn> {
        Ok(Conn {
            url: self.mcp_status().await?.url,
            token: self.mcp_token().await?,
        })
    }

    pub async fn mcp_list_clients(&self) -> Result<Vec<ClientInfo>> {
        tokio::task::spawn_blocking(list)
            .await
            .map_err(|e| CoreError::Other(e.to_string()))
    }

    pub async fn mcp_client_snippet(&self, id: String) -> Result<String> {
        let conn = self.mcp_conn().await?;
        tokio::task::spawn_blocking(move || snippet(&id, &conn))
            .await
            .map_err(|e| CoreError::Other(e.to_string()))?
    }

    pub async fn mcp_install_client(&self, id: String) -> Result<InstallResult> {
        let conn = self.mcp_conn().await?;
        tokio::task::spawn_blocking(move || install(&id, &conn))
            .await
            .map_err(|e| CoreError::Other(e.to_string()))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Conn {
        Conn {
            url: "http://127.0.0.1:47823/mcp".into(),
            token: "tok".into(),
        }
    }

    #[test]
    fn merges_json_and_keeps_other_servers() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        std::fs::write(
            &file,
            r#"{"theme":"dark","mcpServers":{"other":{"url":"x"}}}"#,
        )
        .unwrap();
        let (path, entry) = json_entry("cursor", &conn()).unwrap();
        merge_json_config(&file, path, entry).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["mcpServers"]["other"]["url"], "x");
        assert_eq!(
            v["mcpServers"]["comail"]["headers"]["Authorization"],
            "Bearer tok"
        );
        assert!(dir.path().join("mcp.json.bak").exists());
    }

    #[test]
    fn refuses_jsonc() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        let original = "{\n  // comment\n  \"a\": 1\n}";
        std::fs::write(&file, original).unwrap();
        let (path, entry) = json_entry("gemini", &conn()).unwrap();
        assert!(merge_json_config(&file, path, entry).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
    }

    #[test]
    fn creates_missing_config() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("nested").join("settings.json");
        let (path, entry) = json_entry("gemini", &conn()).unwrap();
        merge_json_config(&file, path, entry).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            v["mcpServers"]["comail"]["httpUrl"],
            "http://127.0.0.1:47823/mcp"
        );
    }

    #[test]
    fn codex_toml_preserves_existing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        std::fs::write(
            &file,
            "model = \"o3\" # keep me\n\n[mcp_servers.other]\ncommand = \"x\"\n",
        )
        .unwrap();
        merge_codex_config(&file, &conn()).unwrap();
        let s = std::fs::read_to_string(&file).unwrap();
        assert!(s.contains("model = \"o3\" # keep me"));
        assert!(s.contains("[mcp_servers.other]"));
        assert!(s.contains("[mcp_servers.comail]"));
        assert!(s.contains("Bearer tok"));
        // Idempotent: a second add replaces rather than duplicates.
        merge_codex_config(&file, &conn()).unwrap();
        let s2 = std::fs::read_to_string(&file).unwrap();
        assert_eq!(s2.matches("[mcp_servers.comail]").count(), 1);
    }

    #[test]
    fn every_client_has_a_snippet() {
        for c in CLIENTS {
            let s = snippet(c.id, &conn()).unwrap();
            assert!(s.contains("127.0.0.1:47823"), "{} snippet lacks url", c.id);
        }
    }

    #[test]
    fn deeplinks_encode_config() {
        let cursor = deeplink("cursor", &conn()).unwrap();
        assert!(
            cursor
                .starts_with("cursor://anysphere.cursor-deeplink/mcp/install?name=comail&config=")
        );
        let vs = deeplink("vscode", &conn()).unwrap();
        assert!(vs.starts_with("vscode:mcp/install?%7B"));
    }
}
