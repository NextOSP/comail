use crate::error::Result;
use crate::models::Settings;
use rusqlite::{params, Connection, OptionalExtension};

pub fn get(conn: &Connection) -> Result<Settings> {
    let json: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'settings'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(json
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default())
}

pub fn set(conn: &Connection, settings: &Settings) -> Result<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES ('settings', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![serde_json::to_string(settings)?],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testutil;

    #[test]
    fn defaults_when_unset_and_roundtrip() {
        let c = testutil::conn();
        let d = get(&c).unwrap();
        assert!(d.notifications_enabled);
        assert!(d.auto_advance);
        assert!(d.auto_labels_enabled);

        let mut s = d.clone();
        s.theme = "carbon".into();
        s.notifications_enabled = false;
        s.signatures.insert("1".into(), "Best,\nDean".into());
        set(&c, &s).unwrap();

        let back = get(&c).unwrap();
        assert_eq!(back.theme, "carbon");
        assert!(!back.notifications_enabled);
        assert_eq!(back.signatures.get("1").map(String::as_str), Some("Best,\nDean"));
    }

    /// Blobs written before new fields existed must deserialize with defaults.
    #[test]
    fn old_blob_gets_field_defaults() {
        let c = testutil::conn();
        c.execute(
            "INSERT INTO app_settings (key, value) VALUES ('settings',
             '{\"theme\":\"snow\",\"undoSendSeconds\":20,\"loadRemoteImages\":true}')",
            [],
        )
        .unwrap();
        let s = get(&c).unwrap();
        assert_eq!(s.theme, "snow");
        assert_eq!(s.undo_send_seconds, 20);
        assert!(s.load_remote_images);
        // serde defaults for everything added since
        assert!(s.notifications_enabled);
        assert!(s.auto_advance);
        assert!(s.auto_labels_enabled);
        assert!(s.signatures.is_empty());
    }
}
