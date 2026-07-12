//! Local, offline-first text embeddings for semantic search + RAG.
//!
//! Uses candle (pure Rust, CPU) to run small BERT-family sentence encoders
//! (BGE / MiniLM). No ONNX runtime, no native ML libs - comail stays a single
//! static binary. Inference is CPU-heavy, so callers must run [`Embedder::embed`]
//! off the DB writer thread (e.g. under `tokio::task::spawn_blocking`).

use crate::error::{CoreError, Result};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub mod store;
pub mod worker;

use store::VectorIndex;
use tokio::sync::RwLock;

/// Shared, cloneable semantic-search runtime state held on `Core`: the loaded
/// local model, the in-memory vector index, and the id of the model both are
/// currently scoped to. `active_model` is empty until the first model loads.
pub struct EmbedState {
    pub index: RwLock<VectorIndex>,
    pub local: RwLock<Option<Arc<LocalCandle>>>,
    pub active_model: RwLock<String>,
    /// Recent query-text -> embedding cache. Typing, backspacing, and re-runs
    /// repeat the same strings; a hit skips a full model forward pass.
    query_cache: RwLock<std::collections::HashMap<String, Vec<f32>>>,
}

/// Evict the whole query cache once it exceeds this; entries are tiny
/// (a few hundred floats) and queries are transient, so LRU bookkeeping
/// isn't worth it.
const QUERY_CACHE_CAP: usize = 256;

impl EmbedState {
    pub fn new() -> Self {
        EmbedState {
            index: RwLock::new(VectorIndex::new(0, "")),
            local: RwLock::new(None),
            active_model: RwLock::new(String::new()),
            query_cache: RwLock::new(std::collections::HashMap::new()),
        }
    }

    /// The currently loaded local embedder, if any.
    pub async fn embedder(&self) -> Option<Arc<LocalCandle>> {
        self.local.read().await.clone()
    }

    pub async fn cached_query(&self, text: &str) -> Option<Vec<f32>> {
        self.query_cache.read().await.get(text).cloned()
    }

    pub async fn cache_query(&self, text: String, vec: Vec<f32>) {
        let mut cache = self.query_cache.write().await;
        if cache.len() >= QUERY_CACHE_CAP {
            cache.clear();
        }
        cache.insert(text, vec);
    }

    /// Drop cached query embeddings (call when the active model changes).
    pub async fn clear_query_cache(&self) {
        self.query_cache.write().await.clear();
    }
}

impl Default for EmbedState {
    fn default() -> Self {
        Self::new()
    }
}

/// A supported local embedding model. The registry is the single source of
/// truth for a model's vector dimension and its query-side instruction prefix.
#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    /// Stable registry key, also the settings value and on-disk dir name.
    pub key: &'static str,
    /// HuggingFace repo id used to download weights on demand.
    pub hf_repo: &'static str,
    /// Output vector dimension.
    pub dim: usize,
    /// Max input tokens per chunk.
    pub max_tokens: usize,
    /// Instruction prepended to *query* text (not passages). BGE models are
    /// trained with a retrieval instruction; MiniLM uses none.
    pub query_prefix: &'static str,
}

const REGISTRY: &[ModelSpec] = &[
    ModelSpec {
        key: "bge-small-en-v1.5",
        hf_repo: "BAAI/bge-small-en-v1.5",
        dim: 384,
        max_tokens: 512,
        query_prefix: "Represent this sentence for searching relevant passages: ",
    },
    ModelSpec {
        key: "all-MiniLM-L6-v2",
        hf_repo: "sentence-transformers/all-MiniLM-L6-v2",
        dim: 384,
        max_tokens: 256,
        query_prefix: "",
    },
    ModelSpec {
        key: "bge-base-en-v1.5",
        hf_repo: "BAAI/bge-base-en-v1.5",
        dim: 768,
        max_tokens: 512,
        query_prefix: "Represent this sentence for searching relevant passages: ",
    },
];

/// The model used when none is configured. Bundled in the installer so first
/// run is fully offline.
pub const DEFAULT_MODEL: &str = "bge-small-en-v1.5";

pub fn registry() -> &'static [ModelSpec] {
    REGISTRY
}

pub fn spec(key: &str) -> Option<&'static ModelSpec> {
    REGISTRY.iter().find(|m| m.key == key)
}

/// Resolve a settings value to a spec, falling back to the default model.
pub fn spec_or_default(key: &str) -> &'static ModelSpec {
    spec(key).unwrap_or_else(|| spec(DEFAULT_MODEL).expect("default model in registry"))
}

/// Anything that turns text into normalized vectors.
pub trait Embedder: Send + Sync {
    /// Embed a batch of passages. Returned vectors are L2-normalized so cosine
    /// similarity is a plain dot product.
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
    fn dim(&self) -> usize;
    fn model_id(&self) -> &str;
    /// Embed one query string, applying the model's retrieval-instruction prefix.
    fn embed_query(&self, query: &str) -> Result<Vec<f32>> {
        let prefixed = format!("{}{}", self.query_prefix(), query);
        let mut v = self.embed(std::slice::from_ref(&prefixed))?;
        v.pop()
            .ok_or_else(|| CoreError::Other("embedder returned no vector".into()))
    }
    fn query_prefix(&self) -> &str {
        ""
    }
}

/// A candle BERT encoder loaded from a local directory of
/// `{config.json, tokenizer.json, model.safetensors}`.
pub struct LocalCandle {
    inner: Mutex<Inner>,
    spec: &'static ModelSpec,
}

struct Inner {
    model: candle_transformers::models::bert::BertModel,
    tokenizer: tokenizers::Tokenizer,
    device: candle_core::Device,
}

impl LocalCandle {
    /// Load a model from `dir`. `dir` must contain config.json, tokenizer.json
    /// and model.safetensors (see [`ensure_model`]).
    pub fn load(dir: &Path, spec: &'static ModelSpec) -> Result<Self> {
        use candle_core::Device;
        use candle_nn::VarBuilder;
        use candle_transformers::models::bert::{BertModel, Config, DTYPE};

        let device = Device::Cpu;
        let cfg_str = std::fs::read_to_string(dir.join("config.json"))
            .map_err(|e| CoreError::Other(format!("embed config: {e}")))?;
        let config: Config = serde_json::from_str(&cfg_str)
            .map_err(|e| CoreError::Other(format!("embed config parse: {e}")))?;

        let mut tokenizer = tokenizers::Tokenizer::from_file(dir.join("tokenizer.json"))
            .map_err(|e| CoreError::Other(format!("embed tokenizer: {e}")))?;
        // Batch inputs to a common length; truncate to the model window.
        tokenizer
            .with_padding(Some(tokenizers::PaddingParams {
                strategy: tokenizers::PaddingStrategy::BatchLongest,
                ..Default::default()
            }))
            .with_truncation(Some(tokenizers::TruncationParams {
                max_length: spec.max_tokens,
                ..Default::default()
            }))
            .map_err(|e| CoreError::Other(format!("embed tokenizer cfg: {e}")))?;

        let weights = dir.join("model.safetensors");
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights], DTYPE, &device)
                .map_err(|e| CoreError::Other(format!("embed weights: {e}")))?
        };
        let model = BertModel::load(vb, &config)
            .map_err(|e| CoreError::Other(format!("embed model load: {e}")))?;

        Ok(LocalCandle {
            inner: Mutex::new(Inner {
                model,
                tokenizer,
                device,
            }),
            spec,
        })
    }
}

impl Embedder for LocalCandle {
    fn dim(&self) -> usize {
        self.spec.dim
    }
    fn model_id(&self) -> &str {
        self.spec.key
    }
    fn query_prefix(&self) -> &str {
        self.spec.query_prefix
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        use candle_core::Tensor;
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let inner = self.inner.lock().unwrap();
        let device = &inner.device;

        let encodings = inner
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| CoreError::Other(format!("tokenize: {e}")))?;

        let map = |e: candle_core::Error| CoreError::Other(format!("embed fwd: {e}"));

        let mut ids = Vec::with_capacity(encodings.len());
        let mut masks = Vec::with_capacity(encodings.len());
        for enc in &encodings {
            ids.push(Tensor::new(enc.get_ids(), device).map_err(map)?);
            masks.push(Tensor::new(enc.get_attention_mask(), device).map_err(map)?);
        }
        let ids = Tensor::stack(&ids, 0).map_err(map)?;
        let mask = Tensor::stack(&masks, 0).map_err(map)?;
        let token_type_ids = ids.zeros_like().map_err(map)?;

        // [batch, seq, hidden]
        let out = inner
            .model
            .forward(&ids, &token_type_ids, Some(&mask))
            .map_err(map)?;

        // Attention-masked mean pooling over the sequence dimension.
        let mask_f = mask
            .to_dtype(out.dtype())
            .map_err(map)?
            .unsqueeze(2)
            .map_err(map)?; // [b, seq, 1]
        let summed = out
            .broadcast_mul(&mask_f)
            .map_err(map)?
            .sum(1)
            .map_err(map)?; // [b, h]
        let counts = mask_f.sum(1).map_err(map)?; // [b, 1]
        let mean = summed.broadcast_div(&counts).map_err(map)?;

        // L2 normalize so cosine == dot product.
        let norm = mean
            .sqr()
            .map_err(map)?
            .sum_keepdim(candle_core::D::Minus1)
            .map_err(map)?
            .sqrt()
            .map_err(map)?;
        let normalized = mean.broadcast_div(&norm).map_err(map)?;

        normalized
            .to_vec2::<f32>()
            .map_err(|e| CoreError::Other(format!("embed collect: {e}")))
    }
}

// ---------------------------------------------------------------------------
// Text preparation / chunking
// ---------------------------------------------------------------------------

/// Roughly how many characters map to one token - used for approximate chunk
/// sizing (the tokenizer still truncates each chunk exactly).
const CHARS_PER_TOKEN: usize = 4;
const MAX_CHUNKS: usize = 6;

/// Turn a message subject + plaintext body into passage chunks ready to embed.
/// Strips quoted reply history and signatures, prepends the subject to the
/// first chunk, and splits long bodies into overlapping windows.
pub fn prepare_chunks(subject: &str, body: &str, max_tokens: usize) -> Vec<String> {
    let cleaned = clean_body(body);
    let subject = subject.trim();

    let window = max_tokens.saturating_mul(CHARS_PER_TOKEN).max(256);
    let overlap = window / 7; // ~15% overlap

    // The head of the message carries the most signal; prepend the subject.
    let head = if subject.is_empty() {
        cleaned.clone()
    } else {
        format!("{subject}\n\n{cleaned}")
    };

    let chars: Vec<char> = head.chars().collect();
    if chars.len() <= window {
        let s = head.trim();
        return if s.is_empty() {
            Vec::new()
        } else {
            vec![s.to_string()]
        };
    }

    let mut chunks = Vec::new();
    let mut start = 0;
    while start < chars.len() && chunks.len() < MAX_CHUNKS {
        let end = (start + window).min(chars.len());
        let piece: String = chars[start..end].iter().collect();
        let piece = piece.trim();
        if !piece.is_empty() {
            chunks.push(piece.to_string());
        }
        if end == chars.len() {
            break;
        }
        start += window - overlap;
    }
    chunks
}

/// Remove quoted reply history and trailing signatures from plaintext so we
/// embed original content, not repeated quotes.
fn clean_body(body: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for line in body.lines() {
        let t = line.trim_start();
        // Quoted history: ">" prefixed lines and the "On <date>, X wrote:" lead-in.
        if t.starts_with('>') {
            continue;
        }
        // Signature delimiter per RFC 3676 ("-- ").
        if line == "-- " || t == "--" {
            break;
        }
        // Common quote lead-ins that precede a fully-quoted tail.
        let lower = t.to_ascii_lowercase();
        if lower.starts_with("on ") && lower.ends_with("wrote:") {
            break;
        }
        out.push(line);
    }
    let joined = out.join("\n");
    // Collapse excessive blank runs.
    joined.trim().to_string()
}

// ---------------------------------------------------------------------------
// Model files on disk
// ---------------------------------------------------------------------------

/// The three files a candle BERT encoder needs.
pub const MODEL_FILES: &[&str] = &["config.json", "tokenizer.json", "model.safetensors"];

/// Directory holding a model's files: `<models_dir>/<key>`.
pub fn model_dir(models_dir: &Path, key: &str) -> PathBuf {
    models_dir.join(key)
}

/// True if every required file for `key` is present under `models_dir`.
pub fn model_present(models_dir: &Path, key: &str) -> bool {
    let dir = model_dir(models_dir, key);
    MODEL_FILES.iter().all(|f| dir.join(f).exists())
}

/// Download a model's files from HuggingFace into `<models_dir>/<key>` if not
/// already present. Async (hf-hub over reqwest/rustls). Used for models the
/// user picks that aren't bundled; the default model ships in the installer.
pub async fn ensure_model(models_dir: &Path, spec: &ModelSpec) -> Result<PathBuf> {
    let dir = model_dir(models_dir, spec.key);
    if model_present(models_dir, spec.key) {
        return Ok(dir);
    }
    std::fs::create_dir_all(&dir).map_err(|e| CoreError::Other(format!("model dir: {e}")))?;

    let (owner, name) = hf_hub::split_id(spec.hf_repo);
    let client =
        hf_hub::HFClient::new().map_err(|e| CoreError::Other(format!("hf-hub init: {e}")))?;
    let repo = client.model(owner, name);
    for file in MODEL_FILES {
        repo.download_file()
            .filename(*file)
            .local_dir(dir.clone())
            .send()
            .await
            .map_err(|e| CoreError::Other(format!("download {file}: {e}")))?;
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_strip_quotes_and_signature() {
        let body = "Hello there\nplease review the doc\n> old quoted line\n-- \nMy Signature";
        let chunks = prepare_chunks("Project update", body, 512);
        assert_eq!(chunks.len(), 1);
        let c = &chunks[0];
        assert!(c.starts_with("Project update"));
        assert!(c.contains("please review"));
        assert!(!c.contains("old quoted line"));
        assert!(!c.contains("My Signature"));
    }

    #[test]
    fn long_body_splits_into_capped_windows() {
        let body = "word ".repeat(4000);
        let chunks = prepare_chunks("Subj", &body, 128);
        assert!(chunks.len() > 1);
        assert!(chunks.len() <= MAX_CHUNKS);
    }

    // Requires network + ~130MB download; run with `cargo test -p comail-core
    // -- --ignored embed_smoke`.
    #[tokio::test]
    #[ignore]
    async fn embed_smoke() {
        let tmp = std::env::temp_dir().join("comail-embed-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let spec = spec(DEFAULT_MODEL).unwrap();
        let dir = ensure_model(&tmp, spec).await.unwrap();
        let emb = LocalCandle::load(&dir, spec).unwrap();
        assert_eq!(emb.dim(), 384);

        let vecs = emb
            .embed(&[
                "a cat sat on the mat".to_string(),
                "kitten on a rug".to_string(),
            ])
            .unwrap();
        assert_eq!(vecs.len(), 2);
        assert_eq!(vecs[0].len(), 384);
        // L2-normalized: magnitude ~1.
        let mag: f32 = vecs[0].iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((mag - 1.0).abs() < 1e-3, "not normalized: {mag}");
        // Similar sentences should score higher than the query prefix baseline.
        let q = emb.embed_query("where did the cat sit").unwrap();
        let dot: f32 = q.iter().zip(&vecs[0]).map(|(a, b)| a * b).sum();
        assert!(dot > 0.3, "expected semantic similarity, got {dot}");
    }
}
