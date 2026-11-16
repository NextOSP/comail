//! macOS quarantine flag for attachment files Comail writes to disk.
//!
//! Files a browser downloads carry a `com.apple.quarantine` extended
//! attribute, so Gatekeeper checks them (and asks before running anything
//! executable) the first time they're opened. Attachments opened or saved from
//! Comail get the same attribute, so a hostile attachment opened with the OS
//! handler is checked like a download instead of trusted as a local file.
//! Other platforms have no equivalent; there this is a no-op.

use std::path::Path;

/// Extended attribute LaunchServices and Gatekeeper read.
#[cfg(target_os = "macos")]
const ATTR: &str = "com.apple.quarantine";

/// `flags;hex unix time;agent;event id`, the shape browsers write. `0083`
/// marks the file as downloaded and subject to Gatekeeper.
#[cfg(target_os = "macos")]
fn value(now_secs: u64) -> String {
    format!("0083;{now_secs:08x};Comail;")
}

/// Quarantine `path` unless it already carries the attribute. An existing
/// value is kept: it may record that the user already approved the file, and
/// overwriting it would ask again on every open.
#[cfg(target_os = "macos")]
pub fn mark(path: &Path) -> std::io::Result<()> {
    if xattr::get(path, ATTR)?.is_some() {
        return Ok(());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    xattr::set(path, ATTR, value(now).as_bytes())
}

#[cfg(not(target_os = "macos"))]
pub fn mark(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn value_matches_browser_format() {
        assert_eq!(value(0x6900_1234), "0083;69001234;Comail;");
        assert_eq!(value(0x10), "0083;00000010;Comail;");
    }

    #[test]
    fn marks_once_and_keeps_an_existing_value() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("invoice.pdf");
        std::fs::write(&file, b"%PDF").unwrap();

        mark(&file).unwrap();
        let set = xattr::get(&file, ATTR).unwrap().unwrap();
        assert!(String::from_utf8(set).unwrap().starts_with("0083;"));

        // A value Gatekeeper already updated (user approved) is left alone.
        xattr::set(&file, ATTR, b"00c3;69001234;Comail;").unwrap();
        mark(&file).unwrap();
        assert_eq!(
            xattr::get(&file, ATTR).unwrap().unwrap(),
            b"00c3;69001234;Comail;"
        );
    }
}
