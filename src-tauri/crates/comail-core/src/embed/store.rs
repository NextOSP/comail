//! In-memory brute-force vector index + f32<->BLOB codec.
//!
//! At personal-mailbox scale (10k–200k messages, 384-dim) an exact scan is
//! single-digit milliseconds and needs no ANN structure or native extension.
//! Vectors are stored L2-normalized, so cosine similarity is a dot product.
//! The index holds only the *active* model's vectors; it is rebuilt from the
//! `message_embeddings` table at startup and updated incrementally by the
//! embed worker. Callers wrap it in an `RwLock`.

use std::collections::HashMap;

/// Encode an f32 vector as little-endian bytes for BLOB storage.
pub fn to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// Decode a little-endian f32 BLOB. Returns None on a truncated blob.
pub fn from_blob(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.len() % 4 != 0 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

/// One indexed chunk vector.
struct Entry {
    message_id: i64,
    /// Which chunk of the message this vector is; retained for provenance and
    /// future per-chunk features (search dedups to message level today).
    #[allow(dead_code)]
    chunk_index: i32,
}

/// Flat, cache-friendly brute-force cosine index for a single model.
pub struct VectorIndex {
    dim: usize,
    model_id: String,
    /// Row-major `[n * dim]` normalized vectors.
    data: Vec<f32>,
    entries: Vec<Entry>,
}

impl VectorIndex {
    pub fn new(dim: usize, model_id: impl Into<String>) -> Self {
        VectorIndex {
            dim,
            model_id: model_id.into(),
            data: Vec::new(),
            entries: Vec::new(),
        }
    }

    pub fn model_id(&self) -> &str {
        &self.model_id
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Drop all vectors (used when switching models / dimensions).
    pub fn reset(&mut self, dim: usize, model_id: impl Into<String>) {
        self.dim = dim;
        self.model_id = model_id.into();
        self.data.clear();
        self.entries.clear();
    }

    /// Append one chunk vector. Ignored if its dimension doesn't match.
    pub fn push(&mut self, message_id: i64, chunk_index: i32, vec: &[f32]) {
        if vec.len() != self.dim {
            return;
        }
        self.data.extend_from_slice(vec);
        self.entries.push(Entry {
            message_id,
            chunk_index,
        });
    }

    /// Top-k messages by best matching chunk (max-sim). `query` must be
    /// normalized and of matching dimension. Returns (message_id, score),
    /// best first, deduplicated to one entry per message.
    pub fn search(&self, query: &[f32], top_k: usize) -> Vec<(i64, f32)> {
        if query.len() != self.dim || self.entries.is_empty() || top_k == 0 {
            return Vec::new();
        }
        let mut best: HashMap<i64, f32> = HashMap::new();
        for (i, e) in self.entries.iter().enumerate() {
            let row = &self.data[i * self.dim..(i + 1) * self.dim];
            let mut dot = 0.0f32;
            for (a, b) in row.iter().zip(query) {
                dot += a * b;
            }
            best.entry(e.message_id)
                .and_modify(|s| {
                    if dot > *s {
                        *s = dot
                    }
                })
                .or_insert(dot);
        }
        let mut scored: Vec<(i64, f32)> = best.into_iter().collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(top_k);
        scored
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_roundtrip() {
        let v = vec![0.1f32, -0.2, 0.3, 1.5];
        let b = to_blob(&v);
        assert_eq!(b.len(), 16);
        assert_eq!(from_blob(&b).unwrap(), v);
        assert!(from_blob(&b[..15]).is_none());
    }

    #[test]
    fn knn_ranks_by_cosine_and_dedups_by_message() {
        let mut idx = VectorIndex::new(2, "test");
        // message 1: two chunks, one aligned with query
        idx.push(1, 0, &[1.0, 0.0]);
        idx.push(1, 1, &[0.0, 1.0]);
        idx.push(2, 0, &[0.7071, 0.7071]);
        let q = [1.0f32, 0.0];
        let res = idx.search(&q, 5);
        assert_eq!(res.len(), 2); // deduped to 2 messages
        assert_eq!(res[0].0, 1); // message 1 best chunk dot=1.0
        assert!((res[0].1 - 1.0).abs() < 1e-4);
        assert_eq!(res[1].0, 2);
    }
}
