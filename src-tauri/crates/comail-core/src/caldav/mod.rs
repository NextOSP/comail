//! Two-way CalDAV sync: discovery (RFC 6764/4791), incremental pull via
//! sync-collection (RFC 6578) with a calendar-query fallback, and offline-safe
//! push of local edits (PUT If-Match / DELETE). Google is CalDAV-with-OAuth;
//! Microsoft Graph is a future second `kind` behind the same seams.

pub mod discovery;
pub mod http;
pub mod push;
pub mod rrule;
pub mod sync;
pub mod task;
pub mod xml;

pub use http::{DavAuth, DavResponse, HttpTransport, Transport};

use crate::error::CoreError;

/// Google's CalDAV endpoint (caldav.google.com redirects here).
pub const GOOGLE_CALDAV_BASE: &str = "https://apidata.googleusercontent.com/caldav/v2/";

pub fn err(msg: impl Into<String>) -> CoreError {
    CoreError::CalDav(msg.into())
}
