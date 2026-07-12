pub mod accounts;
pub mod actions;
pub mod calendar;
pub mod contacts;
pub mod counts;
pub mod embeddings;
pub mod folders;
pub mod labels;
pub mod messages;
pub mod search;
pub mod settings;
pub mod snippets;
pub mod snoozes;
pub mod splits;
pub mod threads;

use crate::models::Address;

pub(crate) fn parse_addrs(json: &str) -> Vec<Address> {
    serde_json::from_str(json).unwrap_or_default()
}
