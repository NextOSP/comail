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
    let mut settings: Settings = json
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default();
    // Fold any legacy plain-text signatures into the rich model. Migrated data is
    // persisted on the next `set()`.
    settings.migrate_signatures();
    Ok(settings)
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
        s.signature_list.push(crate::models::Signature {
            id: "a".into(),
            account_id: 1,
            name: "Work".into(),
            html: "<b>Dean</b>".into(),
        });
        s.signature_defaults.insert(
            "1".into(),
            crate::models::SignatureDefaults {
                new_id: Some("a".into()),
                reply_id: None,
            },
        );
        set(&c, &s).unwrap();

        let back = get(&c).unwrap();
        assert_eq!(back.theme, "carbon");
        assert!(!back.notifications_enabled);
        assert_eq!(back.signature_list.len(), 1);
        assert_eq!(back.signature_list[0].html, "<b>Dean</b>");
        assert_eq!(
            back.signature_defaults
                .get("1")
                .and_then(|d| d.new_id.as_deref()),
            Some("a")
        );
    }

    /// A legacy plain-text `signatures` blob is folded into the rich model on
    /// read: one named signature per account, set as both new and reply default.
    #[test]
    fn legacy_signatures_migrate_on_read() {
        let c = testutil::conn();
        c.execute(
            "INSERT INTO app_settings (key, value) VALUES ('settings',
             '{\"theme\":\"snow\",\"undoSendSeconds\":10,\"loadRemoteImages\":false,\"signatures\":{\"1\":\"Best,\\nDean\"}}')",
            [],
        )
        .unwrap();
        let s = get(&c).unwrap();
        assert!(s.signatures.is_empty(), "legacy field cleared after fold");
        assert_eq!(s.signature_list.len(), 1);
        let sig = &s.signature_list[0];
        assert_eq!(sig.account_id, 1);
        assert_eq!(sig.html, "Best,<br>Dean");
        let def = s.signature_defaults.get("1").unwrap();
        assert_eq!(def.new_id.as_deref(), Some(sig.id.as_str()));
        assert_eq!(def.reply_id.as_deref(), Some(sig.id.as_str()));
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
