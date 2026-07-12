//! Minimal localhost loopback server for the OAuth authorization-code
//! redirect. Binds an ephemeral 127.0.0.1 port, waits for exactly one
//! GET /callback?code=...&state=..., replies with a close-this-tab page.

use crate::error::{CoreError, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct LoopbackServer {
    listener: TcpListener,
    pub port: u16,
}

pub struct AuthCode {
    pub code: String,
    pub state: Option<String>,
}

impl LoopbackServer {
    pub async fn bind() -> Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        Ok(LoopbackServer { listener, port })
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback", self.port)
    }

    /// Wait (with timeout) for the browser redirect carrying ?code=.
    pub async fn wait_for_code(self, timeout: std::time::Duration) -> Result<AuthCode> {
        let fut = async {
            loop {
                let (mut stream, _) = self.listener.accept().await?;
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await?;
                let req = String::from_utf8_lossy(&buf[..n]);
                let first_line = req.lines().next().unwrap_or("");
                // GET /callback?code=...&state=... HTTP/1.1
                let path = first_line.split_whitespace().nth(1).unwrap_or("");
                let query = path.splitn(2, '?').nth(1).unwrap_or("");
                let mut code = None;
                let mut state = None;
                let mut error = None;
                for pair in query.split('&') {
                    let mut it = pair.splitn(2, '=');
                    let k = it.next().unwrap_or("");
                    let v = it.next().unwrap_or("");
                    let v = urldecode(v);
                    match k {
                        "code" => code = Some(v),
                        "state" => state = Some(v),
                        "error" => error = Some(v),
                        _ => {}
                    }
                }
                let body = if code.is_some() {
                    "<html><body style=\"font-family:sans-serif;padding:4rem;text-align:center\">\
                     <h2>Comail is connected.</h2><p>You can close this tab.</p></body></html>"
                } else {
                    "<html><body style=\"font-family:sans-serif;padding:4rem;text-align:center\">\
                     <h2>Sign-in failed.</h2><p>Return to Comail and try again.</p></body></html>"
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes()).await;
                let _ = stream.shutdown().await;

                if let Some(e) = error {
                    return Err(CoreError::Auth(format!("oauth error: {e}")));
                }
                if let Some(code) = code {
                    return Ok(AuthCode { code, state });
                }
                // Ignore stray requests (favicon etc.) and keep listening.
            }
        };
        tokio::time::timeout(timeout, fut)
            .await
            .map_err(|_| CoreError::Auth("sign-in timed out".into()))?
    }
}

fn urldecode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(b);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
