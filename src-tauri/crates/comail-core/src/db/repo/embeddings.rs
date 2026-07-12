//! Persistence for the semantic-search vector store (`message_embeddings`)
//! and the per-message embed lifecycle flag on `messages`.

use crate::embed::store::{from_blob, to_blob};
use crate::error::Result;
use rusqlite::{params, Connection};

/// Mark a message as needing (re-)embedding. Called when a body is stored.
pub fn mark_pending(conn: &Connection, message_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE messages SET embedding_state = 'pending' WHERE id = ?1",
        params![message_id],
    )?;
    Ok(())
}

/// Queue every message that has a cached body for (re-)embedding. Used on a
/// full reindex / model switch.
pub fn mark_all_pending(conn: &Connection) -> Result<usize> {
    let n = conn.execute(
        "UPDATE messages SET embedding_state = 'pending' WHERE body_state = 'cached'",
        [],
    )?;
    Ok(n)
}

/// Newest-first message ids awaiting embedding (body already cached).
pub fn pending(conn: &Connection, limit: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM messages
         WHERE embedding_state = 'pending' AND body_state = 'cached'
         ORDER BY date DESC LIMIT ?1",
    )?;
    let ids = stmt
        .query_map(params![limit], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// Subject + plaintext body for a message, for chunking/embedding.
pub fn source_text(conn: &Connection, message_id: i64) -> Result<Option<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT m.subject, COALESCE(b.text_body, m.snippet, '')
         FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id
         WHERE m.id = ?1",
    )?;
    let row = stmt
        .query_row(params![message_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .ok();
    Ok(row)
}

/// Replace a message's vectors for `model_id` and mark it embedded. An empty
/// `vectors` still flips the flag to 'done' so we don't rescan empty bodies.
pub fn store_vectors(
    conn: &Connection,
    message_id: i64,
    model_id: &str,
    dim: usize,
    vectors: &[Vec<f32>],
) -> Result<()> {
    conn.execute(
        "DELETE FROM message_embeddings WHERE message_id = ?1 AND model_id = ?2",
        params![message_id, model_id],
    )?;
    for (i, v) in vectors.iter().enumerate() {
        conn.execute(
            "INSERT INTO message_embeddings (message_id, chunk_index, model_id, dim, vec)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![message_id, i as i64, model_id, dim as i64, to_blob(v)],
        )?;
    }
    conn.execute(
        "UPDATE messages SET embedding_state = 'done' WHERE id = ?1",
        params![message_id],
    )?;
    Ok(())
}

/// All stored vectors for a model, for building the in-memory index at startup.
#[allow(clippy::type_complexity)]
pub fn load_all(conn: &Connection, model_id: &str) -> Result<Vec<(i64, i32, Vec<f32>)>> {
    let mut stmt = conn.prepare(
        "SELECT message_id, chunk_index, vec FROM message_embeddings WHERE model_id = ?1",
    )?;
    let rows = stmt
        .query_map(params![model_id], |r| {
            let mid: i64 = r.get(0)?;
            let ci: i64 = r.get(1)?;
            let blob: Vec<u8> = r.get(2)?;
            Ok((mid, ci as i32, blob))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(rows.len());
    for (mid, ci, blob) in rows {
        if let Some(v) = from_blob(&blob) {
            out.push((mid, ci, v));
        }
    }
    Ok(out)
}

/// (cached bodies, messages embedded for `model_id`, pending) for status UI.
pub fn counts(conn: &Connection, model_id: &str) -> Result<(i64, i64, i64)> {
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE body_state = 'cached'",
        [],
        |r| r.get(0),
    )?;
    let embedded: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT message_id) FROM message_embeddings WHERE model_id = ?1",
        params![model_id],
        |r| r.get(0),
    )?;
    let pending: i64 = conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE embedding_state = 'pending' AND body_state = 'cached'",
        [],
        |r| r.get(0),
    )?;
    Ok((total, embedded, pending))
}

/// Delete vectors for every model except `keep_model_id` (reclaim space after
/// a model switch once the new corpus is built).
pub fn prune_other_models(conn: &Connection, keep_model_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM message_embeddings WHERE model_id <> ?1",
        params![keep_model_id],
    )?;
    Ok(())
}
