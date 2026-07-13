use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("network error: {0}")]
    Network(String),
    #[error("imap error: {0}")]
    Imap(String),
    #[error("smtp error: {0}")]
    Smtp(String),
    #[error("tls error: {0}")]
    Tls(String),
    #[error("auth failed: {0}")]
    Auth(String),
    #[error("account needs re-authentication")]
    NeedsReauth,
    #[error("keyring error: {0}")]
    Keyring(String),
    #[error("mime error: {0}")]
    Mime(String),
    #[error("caldav error: {0}")]
    CalDav(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("offline")]
    Offline,
    #[error("AI is not configured")]
    AiNotConfigured,
    #[error("{0}")]
    Other(String),
}

impl CoreError {
    /// Stable, language-agnostic token identifying the error variant. The
    /// frontend maps this to a localized message (see src/i18n/locales/*/errors.json);
    /// the human-readable Display string is only a fallback.
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::Db(_) => "db",
            CoreError::Io(_) => "io",
            CoreError::Network(_) => "network",
            CoreError::Imap(_) => "imap",
            CoreError::Smtp(_) => "smtp",
            CoreError::Tls(_) => "tls",
            CoreError::Auth(_) => "auth",
            CoreError::NeedsReauth => "needs_reauth",
            CoreError::Keyring(_) => "keyring",
            CoreError::Mime(_) => "mime",
            CoreError::CalDav(_) => "caldav",
            CoreError::NotFound(_) => "not_found",
            CoreError::Offline => "offline",
            CoreError::AiNotConfigured => "ai_not_configured",
            CoreError::Other(_) => "other",
        }
    }

    /// JSON string crossing the IPC boundary: `{"code","message"}`. The
    /// frontend parses this in src/ipc/errors.ts to localize by code.
    pub fn to_ipc_json(&self) -> String {
        serde_json::json!({ "code": self.code(), "message": self.to_string() }).to_string()
    }
}

impl From<anyhow::Error> for CoreError {
    fn from(e: anyhow::Error) -> Self {
        CoreError::Other(e.to_string())
    }
}

impl From<keyring::Error> for CoreError {
    fn from(e: keyring::Error) -> Self {
        CoreError::Keyring(e.to_string())
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(e: serde_json::Error) -> Self {
        CoreError::Other(format!("json: {e}"))
    }
}

pub type Result<T> = std::result::Result<T, CoreError>;
