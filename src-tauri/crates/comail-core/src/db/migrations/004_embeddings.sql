-- Semantic-search vector store. One row per (message, chunk, model). Vectors
-- are L2-normalized f32 stored little-endian as a BLOB, so cosine == dot.
CREATE TABLE message_embeddings (
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  model_id    TEXT    NOT NULL,
  dim         INTEGER NOT NULL,
  vec         BLOB    NOT NULL,
  PRIMARY KEY (message_id, chunk_index, model_id)
);
-- Load the active model's vectors at startup / prune stale models.
CREATE INDEX idx_embeddings_model ON message_embeddings(model_id);

-- Per-message embed lifecycle. 'done' means embedded for whatever model was
-- active at embed time; switching models resets cached rows to 'pending'.
ALTER TABLE messages ADD COLUMN embedding_state TEXT NOT NULL DEFAULT 'none'
  CHECK (embedding_state IN ('none','pending','done'));

-- Drives the background worker's "newest un-embedded first" scan.
CREATE INDEX idx_messages_embedding_pending ON messages(date DESC)
  WHERE embedding_state = 'pending';
