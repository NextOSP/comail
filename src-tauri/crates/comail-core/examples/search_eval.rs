//! Offline search evaluation against a real mailbox copy, without starting
//! sync: runs the same pipeline as `Core::search` (keyword candidates, query
//! embedding + KNN, `rank`) and prints the top results with their tier and
//! match reason, plus the semantic score distribution for calibrating the
//! similarity floor.
//!
//! cargo run --release --example search_eval -- <comail.db copy> <models dir> [query ...]
//!
//! Point it at a COPY of the database: pending migrations are applied to it
//! (searching itself only reads), so never aim it at the live app's file.

use comail_core::db::repo;
use comail_core::embed::store::VectorIndex;
use comail_core::embed::{self, Embedder, LocalCandle};
use comail_core::search;
use rusqlite::Connection;

const DEFAULT_QUERIES: &[&str] = &[
    "certificate",
    "invoice",
    "hùng",
    "hung",
    "báo giá",
    "SAL-QTN-2026-00371",
    "renewal ovh",
    "rfid",
    "apple",
    "from:me last:7days",
    "label:marketing",
    "lable:work",
    "meeting schedule next week",
    "payment failed",
    "hợp đồng",
];

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [db_path, models_dir, queries @ ..] = args.as_slice() else {
        eprintln!("usage: search_eval <comail.db copy> <models dir> [query ...]");
        std::process::exit(2);
    };
    let mut conn = Connection::open(db_path).expect("open db");
    comail_core::db::migrations::run(&mut conn).expect("migrate the copy");

    let model_key: String = conn
        .query_row(
            "SELECT model_id FROM message_embeddings GROUP BY model_id ORDER BY COUNT(*) DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| embed::DEFAULT_MODEL.to_string());
    let spec = embed::spec_or_default(&model_key);
    let dir = embed::model_dir(std::path::Path::new(models_dir), spec.key);
    let embedder = LocalCandle::load(&dir, spec).ok();
    let mut index = VectorIndex::new(spec.dim, spec.key);
    if embedder.is_some() {
        for (mid, ci, v) in repo::embeddings::load_all(&conn, spec.key).expect("load vectors") {
            index.push(mid, ci, &v);
        }
    }
    println!(
        "model {} ({}), {} vectors\n",
        spec.key,
        if embedder.is_some() {
            "loaded"
        } else {
            "MISSING - keyword only"
        },
        index.len()
    );

    let queries: Vec<String> = if queries.is_empty() {
        DEFAULT_QUERIES.iter().map(|s| s.to_string()).collect()
    } else {
        queries.to_vec()
    };
    let now = chrono::Utc::now().timestamp_millis();
    for query in queries {
        let q = search::parse(&query);
        let t0 = std::time::Instant::now();
        let lexical =
            repo::search::lexical_candidates(&conn, &q, repo::search::candidate_cap(60)).unwrap();
        let vec_hits = match &embedder {
            Some(e) if q.text.chars().count() >= 3 => {
                index.search(&e.embed_query(&q.text).unwrap(), 200)
            }
            _ => Vec::new(),
        };
        let (n_all, n_partial) = (lexical.all.len(), lexical.partial.len());
        let mut out = repo::search::rank(&conn, &q, lexical, &vec_hits, 60, now).unwrap();
        out.explain = repo::search::explain(&conn, &q).unwrap();
        let took = t0.elapsed();

        let top = vec_hits.first().map_or(0.0, |h| h.1);
        let floor = repo::search::SEMANTIC_MIN_SCORE.max(top - repo::search::SEMANTIC_MAX_GAP);
        let kept = vec_hits.iter().filter(|h| h.1 >= floor).count();
        println!(
            "=== {query:?}  ({took:?})  keyword all={n_all} partial={n_partial}  semantic top={top:.3} kept={kept}/{}",
            vec_hits.len()
        );
        for c in &out.explain.chips {
            println!("    chip {}={}", c.kind, c.value);
        }
        for w in &out.explain.warnings {
            println!("    WARN {} {:?} -> {:?}", w.kind, w.token, w.suggestion);
        }
        for (i, (t, h)) in out.threads.iter().zip(&out.hits).take(10).enumerate() {
            let date = chrono::DateTime::from_timestamp_millis(t.last_message_at)
                .map(|d| d.format("%Y-%m-%d").to_string())
                .unwrap_or_default();
            println!(
                "{:2} T{} {:<8} {date} | {}",
                i + 1,
                h.tier,
                format!("{:?}", h.reason).to_lowercase(),
                t.subject.chars().take(80).collect::<String>()
            );
        }
        println!();
    }
}
