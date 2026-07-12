//! Map IMAP folders to roles: RFC 6154 special-use attributes first, then
//! Gmail-style names, then common-name heuristics.

use crate::imap::RemoteFolder;
use crate::models::roles;

pub fn detect_role(folder: &RemoteFolder) -> Option<&'static str> {
    if folder.name.eq_ignore_ascii_case("INBOX") {
        return Some(roles::INBOX);
    }

    for attr in &folder.attributes {
        // Attributes are Debug-formatted and lowercased. imap-proto parses
        // RFC 6154 special-use into typed variants ("sent", "junk", ...);
        // servers it doesn't recognize come through as extension("\\sent").
        if attr == "sent" || attr.contains("\\sent") {
            return Some(roles::SENT);
        }
        if attr == "drafts" || attr.contains("\\drafts") {
            return Some(roles::DRAFTS);
        }
        if attr == "trash" || attr.contains("\\trash") {
            return Some(roles::TRASH);
        }
        if attr == "junk" || attr.contains("\\junk") {
            return Some(roles::SPAM);
        }
        if attr == "archive" || attr.contains("\\archive") {
            return Some(roles::ARCHIVE);
        }
        if attr == "all" || attr.contains("\\all") {
            return Some(roles::ALL);
        }
    }

    let last_segment = folder
        .delimiter
        .as_deref()
        .and_then(|d| folder.name.rsplit(d).next())
        .unwrap_or(&folder.name)
        .to_lowercase();
    let full = folder.name.to_lowercase();

    if full.starts_with("[gmail]") || full.starts_with("[google mail]") {
        return match last_segment.as_str() {
            "sent mail" => Some(roles::SENT),
            "drafts" => Some(roles::DRAFTS),
            "trash" | "bin" => Some(roles::TRASH),
            "spam" => Some(roles::SPAM),
            "all mail" => Some(roles::ALL),
            _ => None, // Starred/Important are views, not folders we sync
        };
    }

    match last_segment.as_str() {
        "sent" | "sent items" | "sent messages" | "sent-mail" => Some(roles::SENT),
        "drafts" | "draft" => Some(roles::DRAFTS),
        "trash" | "deleted" | "deleted items" | "deleted messages" | "bin" => Some(roles::TRASH),
        "spam" | "junk" | "junk mail" | "junk e-mail" => Some(roles::SPAM),
        "archive" | "archives" | "all mail" => Some(roles::ARCHIVE),
        _ => None,
    }
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
