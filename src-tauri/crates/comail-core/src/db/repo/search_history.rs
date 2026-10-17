//! Local search feedback: which threads the user opens out of search results.
//! Ranking turns it into per-thread and per-sender preference scores so the
//! mail the user actually picks keeps rising for them. Never leaves the device.

use crate::error::Result;
use rusqlite::{Connection, params};
use std::collections::HashMap;

/// Events older than this count half as much (and so on).
const HALF_LIFE_MS: f64 = 60.0 * 86_400_000.0;
/// Only the most recent events are kept.
const KEEP: i64 = 2000;

fn decay(now_ms: i64, at_ms: i64) -> f32 {
    let age = (now_ms - at_ms).max(0) as f64;
    0.5f64.powf(age / HALF_LIFE_MS) as f32
}

/// Record that `thread_id` was opened from a search for `query` (the folded
/// free-text part). The sender is the thread's latest incoming sender, so a
/// later search can lift other mail from the same person.
pub fn record(conn: &Connection, query: &str, thread_id: i64, now_ms: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO search_events (query, thread_id, sender, opened_at)
         VALUES (?1, ?2,
           COALESCE((SELECT LOWER(COALESCE(from_addr, '')) FROM messages
                     WHERE thread_id = ?2 AND is_outgoing = 0
                     ORDER BY date DESC LIMIT 1), ''),
           ?3)",
        params![query, thread_id, now_ms],
    )?;
    conn.execute(
        "DELETE FROM search_events WHERE id NOT IN
           (SELECT id FROM search_events ORDER BY opened_at DESC, id DESC LIMIT ?1)",
        params![KEEP],
    )?;
    Ok(())
}

pub fn clear(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM search_events", [])?;
    Ok(())
}

/// Decayed open counts per thread for `thread_ids`. An open from the same
/// query counts double: re-finding the same email is the strongest signal.
pub fn thread_scores(
    conn: &Connection,
    thread_ids: &[i64],
    query: &str,
    now_ms: i64,
) -> Result<HashMap<i64, f32>> {
    let mut out = HashMap::new();
    if thread_ids.is_empty() {
        return Ok(out);
    }
    let ids = thread_ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let mut stmt = conn.prepare(&format!(
        "SELECT thread_id, query, opened_at FROM search_events WHERE thread_id IN ({ids})"
    ))?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })?;
    for row in rows {
        let (tid, q, at) = row?;
        let same = if !query.is_empty() && q == query {
            2.0
        } else {
            1.0
        };
        *out.entry(tid).or_insert(0.0) += same * decay(now_ms, at);
    }
    Ok(out)
}

/// Decayed open counts per sender address (lowercased).
pub fn sender_scores(conn: &Connection, now_ms: i64) -> Result<HashMap<String, f32>> {
    let mut out = HashMap::new();
    let mut stmt =
        conn.prepare_cached("SELECT sender, opened_at FROM search_events WHERE sender != ''")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    for row in rows {
        let (sender, at) = row?;
        *out.entry(sender).or_insert(0.0) += decay(now_ms, at);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testutil;

    #[test]
    fn records_decays_and_clears() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (t1, _) = testutil::seed_message(&c, "Alice@Test.dev", "one", false);
        let (t2, _) = testutil::seed_message(&c, "bob@test.dev", "two", false);
        let now = 1_000 * 86_400_000;

        record(&c, "invoice", t1, now).unwrap();
        record(&c, "other", t1, now).unwrap();
        // An open 60 days ago counts half.
        record(&c, "invoice", t2, now - 60 * 86_400_000).unwrap();

        let t = thread_scores(&c, &[t1, t2], "invoice", now).unwrap();
        assert!((t[&t1] - 3.0).abs() < 1e-4, "same query x2 + other x1");
        assert!((t[&t2] - 1.0).abs() < 1e-4, "same query x2, half-decayed");

        let s = sender_scores(&c, now).unwrap();
        assert!((s["alice@test.dev"] - 2.0).abs() < 1e-4);
        assert!((s["bob@test.dev"] - 0.5).abs() < 1e-4);

        clear(&c).unwrap();
        assert!(thread_scores(&c, &[t1], "", now).unwrap().is_empty());
    }
}
