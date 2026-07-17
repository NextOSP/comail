//! Background embedding worker.
//!
//! A single long-lived task that keeps the semantic index in sync with the
//! mailbox: it loads the configured local model, (re)builds the in-memory
//! index, and batch-embeds any messages flagged `embedding_state='pending'`.
//! Inference runs under `spawn_blocking` so it never touches the DB writer
//! thread; only the short vector write does.

use super::{
    EmbedState, Embedder, LocalCandle, model_dir, model_present, prepare_chunks, spec_or_default,
};
use crate::config::Paths;
use crate::db::{Db, repo};
use crate::embed::store::VectorIndex;
use crate::error::{CoreError, Result};
use std::sync::Arc;
use std::time::Duration;

/// Messages embedded per batch before yielding.
const BATCH: i64 = 4;
/// Cooperative yield between CPU-heavy batches while history is being built.
const WORK_YIELD: Duration = Duration::from_millis(500);
/// Poll interval when there is nothing to embed.
const IDLE: Duration = Duration::from_secs(3);
/// Backoff after a load/inference error.
const ERR_BACKOFF: Duration = Duration::from_secs(30);

/// Spawn the worker. Returns immediately; the task runs for the process life.
pub fn spawn(db: Db, state: Arc<EmbedState>, paths: Arc<Paths>) {
    tokio::spawn(async move {
        run(db, state, paths).await;
    });
}

async fn run(db: Db, state: Arc<EmbedState>, paths: Arc<Paths>) {
    loop {
        match tick(&db, &state, &paths).await {
            Ok(true) => {
                tokio::time::sleep(WORK_YIELD).await;
            }
            Ok(false) => tokio::time::sleep(IDLE).await,
            Err(e) => {
                tracing::warn!("embed worker: {e}");
                tokio::time::sleep(ERR_BACKOFF).await;
            }
        }
    }
}

/// One cycle. Returns Ok(true) if it embedded at least one message.
async fn tick(db: &Db, state: &Arc<EmbedState>, paths: &Arc<Paths>) -> Result<bool> {
    let settings = db.read(|conn| repo::settings::get(conn)).await?;
    if settings.embedding_backend != "local" {
        // Disabled: drop any loaded model so we don't pin memory.
        if state.embedder().await.is_some() {
            *state.local.write().await = None;
            *state.active_model.write().await = String::new();
            *state.index.write().await = VectorIndex::new(0, "");
            state.clear_query_cache().await;
        }
        return Ok(false);
    }

    // Live mail, user actions, and an opened message always outrank semantic
    // indexing. Candle can otherwise consume several CPU cores while the IMAP
    // actor is trying to make the Inbox usable.
    let foreground_busy = db
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM accounts WHERE sync_state = 'syncing'
                    UNION ALL
                    SELECT 1 FROM pending_actions
                     WHERE state IN ('pending','inflight')
                       AND kind NOT LIKE 'cal!_%' ESCAPE '!'
                    UNION ALL
                    SELECT 1
                      FROM messages m
                      JOIN accounts a ON a.id = m.account_id
                      JOIN folders f ON f.id = m.folder_id
                     WHERE m.uid IS NOT NULL
                       AND (a.provider = 'gmail' OR COALESCE(f.role, '') <> 'all')
                       AND (
                         m.body_state = 'fetching'
                         OR (
                           m.body_state = 'none'
                           AND NOT EXISTS (
                             SELECT 1 FROM sync_failures sf
                              WHERE sf.stage = 'content' AND sf.message_id = m.id
                           )
                         )
                       )
                 )",
                [],
                |row| row.get::<_, i64>(0),
            )? != 0)
        })
        .await?;
    if foreground_busy {
        return Ok(false);
    }

    ensure_ready(db, state, paths, &settings.embedding_model).await?;

    let embedder = match state.embedder().await {
        Some(e) => e,
        None => return Ok(false),
    };
    let model_id = embedder.model_id().to_string();
    let dim = embedder.dim();

    let batch = db
        .read(|conn| repo::embeddings::pending(conn, BATCH))
        .await?;
    if batch.is_empty() {
        return Ok(false);
    }

    for mid in batch {
        let src = db
            .read(move |conn| repo::embeddings::source_text(conn, mid))
            .await?;
        let Some((subject, body)) = src else {
            // No text to embed; flip the flag so we don't rescan it.
            let m = model_id.clone();
            db.write(move |conn| repo::embeddings::store_vectors(conn, mid, &m, dim, &[]))
                .await?;
            continue;
        };

        let spec = spec_or_default(&model_id);
        let chunks = prepare_chunks(&subject, &body, spec.max_tokens);
        let vectors = if chunks.is_empty() {
            Vec::new()
        } else {
            let e = embedder.clone();
            tokio::task::spawn_blocking(move || e.embed(&chunks))
                .await
                .map_err(|e| CoreError::Other(format!("embed join: {e}")))??
        };

        let m = model_id.clone();
        let vecs = vectors.clone();
        db.write(move |conn| repo::embeddings::store_vectors(conn, mid, &m, dim, &vecs))
            .await?;

        // Reflect into the live index so new mail is searchable immediately.
        let mut idx = state.index.write().await;
        for (i, v) in vectors.iter().enumerate() {
            idx.push(mid, i as i32, v);
        }
    }
    Ok(true)
}

/// Load the model + build the index if not already scoped to `model_key`.
/// On a genuine model switch, requeue every cached message for re-embedding.
async fn ensure_ready(
    db: &Db,
    state: &Arc<EmbedState>,
    paths: &Arc<Paths>,
    model_key: &str,
) -> Result<()> {
    {
        let active = state.active_model.read().await;
        if *active == model_key && state.embedder().await.is_some() {
            return Ok(());
        }
    }

    let spec = spec_or_default(model_key);
    let models_dir = paths.models_dir();
    if !model_present(&models_dir, spec.key) {
        // Not bundled/copied yet - fetch on demand (network, first use only).
        super::ensure_model(&models_dir, spec).await?;
    }
    let dir = model_dir(&models_dir, spec.key);
    let embedder = tokio::task::spawn_blocking(move || LocalCandle::load(&dir, spec))
        .await
        .map_err(|e| CoreError::Other(format!("embed load join: {e}")))??;
    let embedder = Arc::new(embedder);

    // Rebuild the index from whatever is already stored for this model.
    let model_id = spec.key.to_string();
    let rows = {
        let m = model_id.clone();
        db.read(move |conn| repo::embeddings::load_all(conn, &m))
            .await?
    };
    let mut idx = VectorIndex::new(spec.dim, spec.key);
    for (mid, ci, v) in rows {
        idx.push(mid, ci, &v);
    }

    let prev = state.active_model.read().await.clone();
    let is_switch = !prev.is_empty() && prev != model_id;

    *state.index.write().await = idx;
    *state.local.write().await = Some(embedder);
    *state.active_model.write().await = model_id.clone();
    state.clear_query_cache().await;

    if is_switch {
        tracing::info!("embed model switched {prev} -> {model_id}; requeuing corpus");
        db.write(|conn| repo::embeddings::mark_all_pending(conn).map(|_| ()))
            .await?;
        let m = model_id.clone();
        db.write(move |conn| repo::embeddings::prune_other_models(conn, &m))
            .await?;
    }
    tracing::info!("embed ready: model={model_id}");
    Ok(())
}
