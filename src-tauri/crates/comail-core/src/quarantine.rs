//! "Downloaded from the internet" marking for attachment files Comail writes
//! to disk.
//!
//! Files a browser downloads are marked so the OS checks them (and asks
//! before running anything executable) the first time they're opened.
//! Attachments opened or saved from Comail get the same mark, so a hostile
//! attachment opened with the OS handler is checked like a download instead
//! of trusted as a local file:
//!
//! - macOS: the `com.apple.quarantine` extended attribute (Gatekeeper).
//! - Windows: the Mark of the Web, a `Zone.Identifier` alternate data stream
//!   with `ZoneId=3` (SmartScreen, the "Open File - Security Warning"
//!   prompt, Office Protected View).
//!
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

/// The alternate data stream Windows reads the Mark of the Web from.
#[cfg(windows)]
fn zone_stream(path: &Path) -> std::path::PathBuf {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    stream.into()
}

/// Zone 3 is the Internet zone, what browsers write for a download.
#[cfg(windows)]
const ZONE_IDENTIFIER: &[u8] = b"[ZoneTransfer]\r\nZoneId=3\r\n";

/// Mark `path` with the Mark of the Web unless it already has one (kept for
/// the same reason as on macOS). Volumes without alternate data streams
/// (FAT, exFAT, some network shares) can't carry the mark, as with a browser
/// download saved there; that is not an error.
#[cfg(windows)]
pub fn mark(path: &Path) -> std::io::Result<()> {
    /// `ERROR_INVALID_FUNCTION`, `ERROR_NOT_SUPPORTED`, `ERROR_INVALID_NAME`:
    /// what a volume without stream support answers.
    const NO_STREAMS: [i32; 3] = [1, 50, 123];

    let stream = zone_stream(path);
    if std::fs::metadata(&stream).is_ok() {
        return Ok(());
    }
    match std::fs::write(&stream, ZONE_IDENTIFIER) {
        Err(e) if e.raw_os_error().is_some_and(|c| NO_STREAMS.contains(&c)) => Ok(()),
        other => other,
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn marks_once_and_keeps_an_existing_value() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("invoice.pdf");
        std::fs::write(&file, b"%PDF").unwrap();

        mark(&file).unwrap();
        assert_eq!(std::fs::read(zone_stream(&file)).unwrap(), ZONE_IDENTIFIER);
        // The file's own contents are untouched.
        assert_eq!(std::fs::read(&file).unwrap(), b"%PDF");

        // A mark another tool wrote (e.g. with the source URL) is left alone.
        let custom = b"[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:internet\r\n";
        std::fs::write(zone_stream(&file), custom).unwrap();
        mark(&file).unwrap();
        assert_eq!(std::fs::read(zone_stream(&file)).unwrap(), custom);
    }

    #[test]
    fn mark_survives_the_rename_into_place() {
        let dir = tempfile::tempdir().unwrap();
        let partial = dir.path().join(".download.part");
        let file = dir.path().join("setup.exe");
        std::fs::write(&partial, b"MZ").unwrap();
        mark(&partial).unwrap();
        std::fs::rename(&partial, &file).unwrap();
        assert_eq!(std::fs::read(zone_stream(&file)).unwrap(), ZONE_IDENTIFIER);
    }
}
