use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Paths {
    pub data_dir: PathBuf,
}

impl Paths {
    pub fn default_dirs() -> Self {
        let data_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("comail");
        Paths { data_dir }
    }

    pub fn for_tests(root: &std::path::Path) -> Self {
        Paths {
            data_dir: root.to_path_buf(),
        }
    }

    pub fn db_file(&self) -> PathBuf {
        self.data_dir.join("comail.db")
    }

    /// Directory for raw .eml files of one account.
    pub fn mail_dir(&self, account_id: i64) -> PathBuf {
        self.data_dir.join("mail").join(account_id.to_string())
    }

    /// Directory for extracted attachment files.
    pub fn attachments_dir(&self, account_id: i64) -> PathBuf {
        self.data_dir
            .join("attachments")
            .join(account_id.to_string())
    }

    /// Root for app-managed copies of outgoing (draft) attachments. Files
    /// picked in the composer are staged here so dispatch only ever reads
    /// files the app itself wrote, never an arbitrary frontend-supplied path.
    pub fn draft_attachments_dir(&self) -> PathBuf {
        self.data_dir.join("draft_attachments")
    }

    /// Directory holding local embedding-model weights (`<models_dir>/<key>`).
    pub fn models_dir(&self) -> PathBuf {
        self.data_dir.join("models")
    }

    pub fn ensure(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.data_dir)
    }
}
