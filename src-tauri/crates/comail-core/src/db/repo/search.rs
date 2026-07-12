use crate::error::Result;
use crate::models::{Address, ThreadSummary};
use crate::search::ParsedQuery;
use rusqlite::{params, Connection};
use std::collections::HashMap;

/// Index (or re-index) a message into the contentless FTS table.
pub fn index_message(conn: &Connection, message_id: i64) -> Result<()> {
    // Contentless FTS5: delete then insert with explicit rowid.
    conn.execute(
        "INSERT INTO messages_fts (messages_fts, rowid, subject, from_text, to_text, body)
         VALUES ('delete', ?1, '', '', '', '')",
        params![message_id],
    )
    .ok(); // delete of a non-existent row errors; ignore
    conn.execute(
        "INSERT INTO messages_fts (rowid, subject, from_text, to_text, body)
         SELECT m.id,
                m.subject,
                COALESCE(m.from_name,'') || ' ' || COALESCE(m.from_addr,''),
                m.to_json || ' ' || m.cc_json,
                COALESCE(b.text_body, m.snippet, '')
         FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id
         WHERE m.id = ?1",
        params![message_id],
    )?;
    Ok(())
}

/// Append `from:`/`to:`/`in:`/`is:`/`has:` predicates over the `m` alias.
/// Placeholders are `?n` keyed off the running `bind` length, so this composes
/// with any binds already pushed by the caller.
fn append_operator_clauses(
    q: &ParsedQuery,
    where_clauses: &mut Vec<String>,
    bind: &mut Vec<Box<dyn rusqlite::types::ToSql>>,
) {
    if let Some(from) = &q.from {
        bind.push(Box::new(format!("%{}%", from.to_lowercase())));
        where_clauses.push(format!(
            "(LOWER(COALESCE(m.from_addr,'')) LIKE ?{n} OR LOWER(COALESCE(m.from_name,'')) LIKE ?{n})",
            n = bind.len()
        ));
    }
    if let Some(to) = &q.to {
        bind.push(Box::new(format!("%{}%", to.to_lowercase())));
        where_clauses.push(format!("LOWER(m.to_json) LIKE ?{}", bind.len()));
    }
    if let Some(role) = &q.in_folder {
        bind.push(Box::new(role.clone()));
        where_clauses.push(format!(
            "EXISTS (SELECT 1 FROM folders f WHERE f.id = m.folder_id AND f.role = ?{})",
            bind.len()
        ));
    }
    if q.is_unread == Some(true) {
        where_clauses.push("m.is_read = 0".into());
    }
    if q.is_starred == Some(true) {
        where_clauses.push("m.is_starred = 1".into());
    }
    if q.has_attachment == Some(true) {
        where_clauses.push("m.has_attachments = 1".into());
    }
}

/// Lexical branch: thread ids ranked by bm25 + recency (or, when the query is
/// operators-only, by recency), best first, capped at `cap`.
fn structured_thread_ids(conn: &Connection, q: &ParsedQuery, cap: i64) -> Result<Vec<i64>> {
    let mut where_clauses: Vec<String> = Vec::new();
    let mut bind: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    // bm25() may only be evaluated in a query directly over the FTS table, so
    // rank inside a subquery and join the results to messages. The CTE must be
    // MATERIALIZED: if the planner flattens it into the outer join, bm25()
    // loses its full-text context and the query fails.
    let (cte, fts_join) = if q.fts.is_empty() {
        ("", "")
    } else {
        bind.push(Box::new(q.fts.clone()));
        (
            "WITH f AS MATERIALIZED (
                SELECT rowid AS mid, bm25(messages_fts, 4.0, 2.0, 2.0, 1.0) AS fts_rank
                FROM messages_fts WHERE messages_fts MATCH ?1
                ORDER BY fts_rank LIMIT 2000)",
            "JOIN f ON f.mid = m.id",
        )
    };

    append_operator_clauses(q, &mut where_clauses, &mut bind);

    if where_clauses.is_empty() && q.fts.is_empty() {
        return Ok(Vec::new());
    }

    let rank_expr = if q.fts.is_empty() { "0.0" } else { "f.fts_rank" };
    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!("AND {}", where_clauses.join(" AND "))
    };

    let sql = format!(
        "{cte}
         SELECT m.thread_id, MIN({rank_expr}) AS rank, MAX(m.date) AS d
         FROM messages m {fts_join}
         WHERE m.thread_id IS NOT NULL {where_sql}
         GROUP BY m.thread_id
         ORDER BY rank ASC, d DESC
         LIMIT {cap}"
    );

    // prepare_cached: the SQL text repeats across keystrokes (only binds
    // change), so skip re-planning on every call.
    let mut stmt = conn.prepare_cached(&sql)?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let ids = stmt
        .query_map(params_ref.as_slice(), |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// How many candidate thread ids each branch feeds into fusion for a given
/// result `limit`.
pub fn candidate_cap(limit: i64) -> usize {
    (limit.max(1) as usize * 4).clamp(50, 400)
}

/// Lexical candidates for `hybrid`'s fusion: bm25-ranked thread ids, retrying
/// relaxed (OR) when the all-terms query finds nothing. Split out so callers
/// can run it concurrently with query embedding.
pub fn lexical_thread_ids(conn: &Connection, q: &ParsedQuery, cap: usize) -> Result<Vec<i64>> {
    let ids = structured_thread_ids(conn, q, cap as i64)?;
    if !ids.is_empty() || q.fts.is_empty() || q.fts_or == q.fts {
        return Ok(ids);
    }
    let mut relaxed = q.clone();
    relaxed.fts = q.fts_or.clone();
    structured_thread_ids(conn, &relaxed, cap as i64)
}

/// For a set of candidate message ids, return message_id -> thread_id for those
/// that satisfy the query's operator filters. Ids are trusted (from our own
/// vector index), so they are inlined rather than bound.
fn allowed_message_threads(
    conn: &Connection,
    q: &ParsedQuery,
    ids: &[i64],
) -> Result<HashMap<i64, i64>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut where_clauses: Vec<String> = Vec::new();
    let mut bind: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    append_operator_clauses(q, &mut where_clauses, &mut bind);

    let id_list = ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!("AND {}", where_clauses.join(" AND "))
    };
    let sql = format!(
        "SELECT m.id, m.thread_id FROM messages m
         WHERE m.thread_id IS NOT NULL AND m.id IN ({id_list}) {where_sql}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let mut map = HashMap::new();
    let rows = stmt.query_map(params_ref.as_slice(), |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
    })?;
    for row in rows {
        let (mid, tid) = row?;
        map.insert(mid, tid);
    }
    Ok(map)
}

/// Semantic branch: fold message-level vector hits (already score-sorted) into
/// an operator-filtered, best-first, de-duplicated thread-id list.
fn vector_thread_ids(
    conn: &Connection,
    q: &ParsedQuery,
    vec_hits: &[(i64, f32)],
    cap: usize,
) -> Result<Vec<i64>> {
    if vec_hits.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<i64> = vec_hits.iter().map(|(id, _)| *id).collect();
    let allowed = allowed_message_threads(conn, q, &ids)?;

    let mut seen = std::collections::HashSet::new();
    let mut threads = Vec::new();
    for (mid, _score) in vec_hits {
        if let Some(&tid) = allowed.get(mid) {
            if seen.insert(tid) {
                threads.push(tid);
                if threads.len() >= cap {
                    break;
                }
            }
        }
    }
    Ok(threads)
}

/// Reciprocal Rank Fusion. Scale-free, so it merges bm25 and cosine rankings
/// without normalizing their incomparable score ranges.
fn rrf(lists: &[Vec<i64>]) -> Vec<(i64, f32)> {
    const K: f32 = 60.0;
    let mut score: HashMap<i64, f32> = HashMap::new();
    for list in lists {
        for (rank, id) in list.iter().enumerate() {
            *score.entry(*id).or_insert(0.0) += 1.0 / (K + rank as f32 + 1.0);
        }
    }
    let mut fused: Vec<(i64, f32)> = score.into_iter().collect();
    fused.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    fused
}

/// Add per-thread sender-affinity and recency bonuses to fused RRF scores, so
/// mail from people the user actually corresponds with (and fresher threads)
/// outranks equally-matching noise. Bonus weights live on the RRF scale -
/// a single-list top rank scores 1/61 ≈ 0.016 - sized so a strong personal
/// signal can lift a mid-list hit to the top without burying exact matches.
fn apply_personal_boosts(
    conn: &Connection,
    scored: &mut [(i64, f32)],
    now_ms: i64,
) -> Result<()> {
    if scored.is_empty() {
        return Ok(());
    }
    let id_list = scored
        .iter()
        .map(|(id, _)| id.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT m.thread_id, MAX(m.date), MAX(c.send_count * 3 + c.recv_count)
         FROM messages m
         LEFT JOIN contacts c ON c.email = LOWER(COALESCE(m.from_addr, ''))
         WHERE m.thread_id IN ({id_list})
         GROUP BY m.thread_id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut info: HashMap<i64, (i64, i64)> = HashMap::new();
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, Option<i64>>(2)?.unwrap_or(0),
        ))
    })?;
    for row in rows {
        let (tid, date_ms, affinity) = row?;
        info.insert(tid, (date_ms, affinity));
    }
    for (tid, score) in scored.iter_mut() {
        let Some(&(date_ms, affinity)) = info.get(tid) else {
            continue;
        };
        let affinity = affinity as f32;
        let age_days = ((now_ms - date_ms).max(0) as f32) / 86_400_000.0;
        *score += 0.008 * (affinity / (affinity + 25.0)) + 0.004 / (1.0 + age_days / 30.0);
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    Ok(())
}

/// Lexical-only search (FTS5 bm25 + operator filters), grouped into threads.
/// Retained for callers that don't have a vector index.
pub fn search(conn: &Connection, q: &ParsedQuery, limit: i64) -> Result<Vec<ThreadSummary>> {
    let thread_ids = structured_thread_ids(conn, q, limit)?;
    hydrate(conn, &thread_ids)
}

/// Hybrid search: fuse the lexical (bm25) and semantic (vector KNN) branches
/// with RRF, preserving operator filters, and hydrate to thread summaries.
/// `vec_hits` are (message_id, score) from the in-memory index, score-sorted;
/// pass an empty slice to fall back to lexical-only ranking.
pub fn hybrid(
    conn: &Connection,
    q: &ParsedQuery,
    vec_hits: &[(i64, f32)],
    limit: i64,
) -> Result<Vec<ThreadSummary>> {
    let lexical = lexical_thread_ids(conn, q, candidate_cap(limit))?;
    fuse(conn, q, lexical, vec_hits, limit)
}

/// Second half of `hybrid`: filter the semantic hits, fuse both candidate
/// lists with RRF + personal boosts, and hydrate the top threads. Takes
/// pre-computed lexical ids so the caller can overlap their query with the
/// (CPU-bound) query embedding.
pub fn fuse(
    conn: &Connection,
    q: &ParsedQuery,
    lexical: Vec<i64>,
    vec_hits: &[(i64, f32)],
    limit: i64,
) -> Result<Vec<ThreadSummary>> {
    let semantic = vector_thread_ids(conn, q, vec_hits, candidate_cap(limit))?;

    let lists: Vec<Vec<i64>> = [lexical, semantic]
        .into_iter()
        .filter(|l| !l.is_empty())
        .collect();
    let mut fused = rrf(&lists);
    apply_personal_boosts(conn, &mut fused, chrono::Utc::now().timestamp_millis())?;

    let top: Vec<i64> = fused
        .into_iter()
        .take(limit.max(1) as usize)
        .map(|(id, _)| id)
        .collect();
    hydrate(conn, &top)
}

fn hydrate(conn: &Connection, thread_ids: &[i64]) -> Result<Vec<ThreadSummary>> {
    let mut out = Vec::with_capacity(thread_ids.len());
    for &tid in thread_ids {
        if let Some(t) = super::threads::get_summary(conn, tid)? {
            out.push(t);
        }
    }
    Ok(out)
}

// Silence unused-import warning for Address which is used via ThreadSummary construction elsewhere.
#[allow(unused)]
fn _t(_a: Address) {}
