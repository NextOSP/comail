//! Map IMAP folders to roles, retaining the evidence used for selection.

pub use crate::db::repo::folders::{DetectedRole, RoleSource};
use crate::imap::RemoteFolder;
use crate::models::roles;

pub fn detect_role(folder: &RemoteFolder) -> Option<&'static str> {
    detect_role_with_source(folder).map(|d| d.role)
}

fn attribute_name(attr: &str) -> &str {
    // LIST attributes arrive as typed Debug names or Extension("\\\\Trash").
    attr.strip_prefix("extension(\"")
        .and_then(|s| s.strip_suffix("\")"))
        .unwrap_or(attr)
        .trim_start_matches('\\')
}

pub fn detect_role_with_source(folder: &RemoteFolder) -> Option<DetectedRole> {
    detect_role_with_hints(folder, &[])
}

pub fn detect_role_with_hints(folder: &RemoteFolder, trash_hints: &[&str]) -> Option<DetectedRole> {
    if folder
        .attributes
        .iter()
        .any(|a| attribute_name(&a.to_ascii_lowercase()) == "noselect")
    {
        return None;
    }
    if folder.name.eq_ignore_ascii_case("INBOX") {
        return Some(DetectedRole {
            role: roles::INBOX,
            source: RoleSource::Inbox,
        });
    }

    for attr in &folder.attributes {
        let attr = attr.to_ascii_lowercase();
        let role = match attribute_name(&attr) {
            "sent" => Some(roles::SENT),
            "drafts" => Some(roles::DRAFTS),
            "trash" => Some(roles::TRASH),
            "junk" => Some(roles::SPAM),
            "archive" => Some(roles::ARCHIVE),
            "all" => Some(roles::ALL),
            _ => None,
        };
        if let Some(role) = role {
            return Some(DetectedRole {
                role,
                source: RoleSource::SpecialUse,
            });
        }
    }

    let last_segment = folder
        .delimiter
        .as_deref()
        .and_then(|d| folder.name.rsplit(d).next())
        .unwrap_or(&folder.name)
        .to_lowercase();
    let full = folder.name.to_lowercase();

    if trash_hints
        .iter()
        .any(|hint| folder.name.eq_ignore_ascii_case(hint))
    {
        return Some(DetectedRole {
            role: roles::TRASH,
            source: if full.starts_with("[gmail]") || full.starts_with("[google mail]") {
                RoleSource::GmailName
            } else {
                RoleSource::Name
            },
        });
    }

    if full.starts_with("[gmail]") || full.starts_with("[google mail]") {
        let role = match last_segment.as_str() {
            "sent mail" => Some(roles::SENT),
            "drafts" => Some(roles::DRAFTS),
            "trash" | "bin" => Some(roles::TRASH),
            "spam" => Some(roles::SPAM),
            "all mail" => Some(roles::ALL),
            _ => None,
        };
        return role.map(|role| DetectedRole {
            role,
            source: RoleSource::GmailName,
        });
    }

    let role = match last_segment.as_str() {
        "sent" | "sent items" | "sent messages" | "sent-mail" => Some(roles::SENT),
        "drafts" | "draft" => Some(roles::DRAFTS),
        "trash" | "deleted" | "deleted items" | "deleted messages" | "bin" => Some(roles::TRASH),
        "spam" | "junk" | "junk mail" | "junk e-mail" => Some(roles::SPAM),
        "archive" | "archives" | "all mail" => Some(roles::ARCHIVE),
        _ => None,
    };
    role.map(|role| DetectedRole {
        role,
        source: RoleSource::Name,
    })
}

/// Should this folder be synced at all?
pub fn should_sync(folder: &RemoteFolder, role: Option<&str>) -> bool {
    if folder.attributes.iter().any(|a| a.contains("noselect")) {
        return false;
    }
    let full = folder.name.to_lowercase();
    // Gmail: skip label-folders without roles to avoid duplicate downloads;
    // everything lives in All Mail + INBOX + special folders.
    if (full.starts_with("[gmail]") || full.starts_with("[google mail]")) && role.is_none() {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(name: &str, attributes: &[&str]) -> RemoteFolder {
        RemoteFolder {
            name: name.into(),
            delimiter: Some("/".into()),
            attributes: attributes.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn provider_hints_preserve_special_use_and_noselect_precedence() {
        let hints = ["[Gmail]/Papierkorb", "Deleted Items"];
        assert_eq!(
            detect_role_with_hints(&remote("[Gmail]/Papierkorb", &[]), &hints),
            Some(DetectedRole {
                role: roles::TRASH,
                source: RoleSource::GmailName
            })
        );
        assert_eq!(
            detect_role_with_hints(&remote("Deleted Items", &["\\Sent"]), &hints),
            Some(DetectedRole {
                role: roles::SENT,
                source: RoleSource::SpecialUse
            })
        );
        assert!(
            detect_role_with_hints(&remote("Deleted Items", &["\\Noselect"]), &hints).is_none()
        );
        assert!(
            detect_role_with_hints(&remote("[Gmail]/Papierkorb copies", &[]), &hints).is_none()
        );
    }

    #[test]
    fn special_use_has_provenance_independent_of_localized_name() {
        for name in [
            "[Gmail]/Th&APk-ng r&AOE-c",
            "[Google Mail]/Papierkorb",
            "Deleted Items",
        ] {
            for attr in ["trash", "\\Trash", "extension(\"\\\\trash\")"] {
                let folder = remote(name, &[attr]);
                assert_eq!(
                    detect_role_with_source(&folder),
                    Some(DetectedRole {
                        role: roles::TRASH,
                        source: RoleSource::SpecialUse
                    })
                );
            }
        }
    }

    #[test]
    fn detects_provenance_and_does_not_treat_similar_attributes_as_special_use() {
        for (name, attrs, role, source) in [
            ("INBOX", vec![], roles::INBOX, RoleSource::Inbox),
            ("Trash", vec![], roles::TRASH, RoleSource::Name),
            ("[Gmail]/Trash", vec![], roles::TRASH, RoleSource::GmailName),
            ("Trash", vec!["\\Sent"], roles::SENT, RoleSource::SpecialUse),
            (
                "Drafts",
                vec!["drafts"],
                roles::DRAFTS,
                RoleSource::SpecialUse,
            ),
            ("Junk", vec!["junk"], roles::SPAM, RoleSource::SpecialUse),
            (
                "Archives",
                vec!["archive"],
                roles::ARCHIVE,
                RoleSource::SpecialUse,
            ),
            ("All", vec!["all"], roles::ALL, RoleSource::SpecialUse),
        ] {
            assert_eq!(
                detect_role_with_source(&remote(name, &attrs)),
                Some(DetectedRole { role, source })
            );
        }
        assert!(detect_role_with_source(&remote("Custom", &["\\trashcan"])).is_none());
        assert!(detect_role_with_source(&remote("Trash", &["noselect", "trash"])).is_none());
        assert!(detect_role_with_source(&remote("[Gmail]/Th&APk-ng r&AOE-c", &[])).is_none());
    }
}
