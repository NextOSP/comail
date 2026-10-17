use crate::error::Result;
use crate::models::{ThreadSummary, roles};
use crate::search::{ParsedQuery, SearchExplain, Sort, fold};
use rusqlite::{Connection, params};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// Index (or re-index) a message into the contentless FTS table.
pub fn index_message(conn: &Connection, message_id: i64) -> Result<()> {
    // Migration 013 enables contentless-delete mode, so this removes all old
    // terms without needing to reproduce the values that were indexed before
    // the message changed.
    conn.execute(
        "DELETE FROM messages_fts WHERE rowid = ?1",
        params![message_id],
    )?;
    conn.execute(
        "INSERT INTO messages_fts (rowid, subject, from_text, to_text, body)
         SELECT m.id,
                m.subject,
                COALESCE(m.from_name,'') || ' ' || COALESCE(m.from_addr,''),
                m.to_json || ' ' || m.cc_json,
                CASE
                  WHEN b.text_body IS NULL
                    OR TRIM(b.text_body, char(9) || char(10) || char(11) || char(12) || char(13) || char(32)) = ''
                  THEN COALESCE(m.snippet, '')
                  ELSE b.text_body
                END
         FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id
         WHERE m.id = ?1",
        params![message_id],
    )?;
    Ok(())
}

/// True when the query carries a real matcher (full-text terms or an operator),
/// as opposed to being empty or only account-scoped. Used to decide whether the
/// default Trash/Spam exclusion should apply.
fn has_positive_selector(q: &ParsedQuery) -> bool {
    !q.fts.is_empty()
        || q.from.is_some()
        || q.from_me
        || q.to.is_some()
        || !q.label.is_empty()
        || q.in_folder.is_some()
        || q.is_unread.is_some()
        || q.is_starred == Some(true)
        || q.is_replied
        || q.has_attachment == Some(true)
        || q.has_label
        || q.after_ms.is_some()
        || q.before_ms.is_some()
}

/// Label names compare on folded alphanumerics, so "follow-up", "Follow up"
/// and "FOLLOW UP" are the same label.
fn label_key(s: &str) -> String {
    fold(s).chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Resolve `label:` values to (id, canonical name), by name ignoring case,
/// accents and punctuation. A value that is a prefix of exactly one label
/// also resolves ("label:follow" → "Follow up"). `None` for no such label.
pub fn resolve_labels(conn: &Connection, names: &[String]) -> Result<Vec<Option<(i64, String)>>> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let all = super::labels::list(conn)?;
    let keyed: Vec<(String, &crate::models::Label)> =
        all.iter().map(|l| (label_key(&l.name), l)).collect();
    Ok(names
        .iter()
        .map(|n| {
            let k = label_key(n);
            if k.is_empty() {
                return None;
            }
            if let Some((_, l)) = keyed.iter().find(|(lk, _)| *lk == k) {
                return Some((l.id, l.name.clone()));
            }
            let mut prefixed = keyed.iter().filter(|(lk, _)| lk.starts_with(&k));
            match (prefixed.next(), prefixed.next()) {
                (Some((_, l)), None) => Some((l.id, l.name.clone())),
                _ => None,
            }
        })
        .collect())
}

/// Append `from:`/`to:`/`label:`/`in:`/`is:`/`has:`/date predicates over the
/// `m` alias. Placeholders are `?n` keyed off the running `bind` length, so
/// this composes with any binds already pushed by the caller.
fn append_operator_clauses(
    conn: &Connection,
    q: &ParsedQuery,
    where_clauses: &mut Vec<String>,
    bind: &mut Vec<Box<dyn rusqlite::types::ToSql>>,
) -> Result<()> {
    if let Some(account_id) = q.account_id {
        bind.push(Box::new(account_id));
        where_clauses.push(format!("m.account_id = ?{}", bind.len()));
    }
    if let Some(from) = &q.from {
        bind.push(Box::new(format!("%{}%", from.to_lowercase())));
        where_clauses.push(format!(
            "(LOWER(COALESCE(m.from_addr,'')) LIKE ?{n} OR LOWER(COALESCE(m.from_name,'')) LIKE ?{n})",
            n = bind.len()
        ));
    }
    if q.from_me {
        where_clauses.push("m.is_outgoing = 1".into());
    }
    if let Some(to) = &q.to {
        bind.push(Box::new(format!("%{}%", to.to_lowercase())));
        where_clauses.push(format!("LOWER(m.to_json) LIKE ?{}", bind.len()));
    }
    // Every `label:` must hold. A label lives on messages (`message_labels`)
    // or, for auto-routed categories, on the thread (`routed_tab`). An unknown
    // label matches nothing rather than being silently ignored.
    for resolved in resolve_labels(conn, &q.label)? {
        match resolved {
            Some((id, _)) => {
                bind.push(Box::new(id));
                let n = bind.len();
                bind.push(Box::new(format!("label:{id}")));
                where_clauses.push(format!(
                    "(EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = ?{n})
                      OR EXISTS (SELECT 1 FROM threads lt WHERE lt.id = m.thread_id AND lt.routed_tab = ?{}))",
                    n + 1
                ));
            }
            None => where_clauses.push("0".into()),
        }
    }
    if let Some(role) = &q.in_folder {
        bind.push(Box::new(role.clone()));
        where_clauses.push(format!(
            "EXISTS (SELECT 1 FROM folders f WHERE f.id = m.folder_id AND f.role = ?{})",
            bind.len()
        ));
    } else if has_positive_selector(q) {
        // No explicit `in:` scope: keep Trash and Spam out of results, the same
        // way the inbox and folder views do. Without this, a `from:`/keyword
        // search matches messages in every folder, so triaging a result (trash,
        // spam) leaves it matching the query and it reappears on the next
        // refetch. `in:trash` / `in:spam` set `in_folder` and opt back in.
        // Gated on there being a real matcher so an empty query still returns
        // nothing (rather than every non-trash thread) via the caller's guard.
        where_clauses.push(format!(
            "NOT EXISTS (SELECT 1 FROM folders f WHERE f.id = m.folder_id AND f.role IN ('{}','{}'))",
            roles::TRASH,
            roles::SPAM
        ));
    }
    match q.is_unread {
        Some(true) => where_clauses.push("m.is_read = 0".into()),
        Some(false) => where_clauses.push("m.is_read = 1".into()),
        None => {}
    }
    if q.is_starred == Some(true) {
        where_clauses.push("m.is_starred = 1".into());
    }
    if q.is_replied {
        where_clauses.push(
            "EXISTS (SELECT 1 FROM messages rm WHERE rm.thread_id = m.thread_id AND rm.is_outgoing = 1)"
                .into(),
        );
    }
    if q.has_attachment == Some(true) {
        where_clauses.push("m.has_attachments = 1".into());
    }
    if q.has_label {
        where_clauses
            .push("EXISTS (SELECT 1 FROM message_labels hl WHERE hl.message_id = m.id)".into());
    }
    if let Some(after) = q.after_ms {
        bind.push(Box::new(after));
        where_clauses.push(format!("m.date >= ?{}", bind.len()));
    }
    if let Some(before) = q.before_ms {
        bind.push(Box::new(before));
        where_clauses.push(format!("m.date < ?{}", bind.len()));
    }
    // `exclude:`/`-term`: drop messages whose FTS content matches any excluded
    // term. Applied here (not in the FTS MATCH string) so it works uniformly
    // whether the message reached us via the lexical bm25 branch or the vector
    // branch, and even when there are no positive FTS terms to hang a `NOT` off.
    if !q.fts_not.is_empty() {
        bind.push(Box::new(q.fts_not.clone()));
        where_clauses.push(format!(
            "m.id NOT IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?{})",
            bind.len()
        ));
    }
    Ok(())
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

    append_operator_clauses(conn, q, &mut where_clauses, &mut bind)?;

    if where_clauses.is_empty() && q.fts.is_empty() {
        return Ok(Vec::new());
    }

    let rank_expr = if q.fts.is_empty() {
        "0.0"
    } else {
        "f.fts_rank"
    };
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

/// Lexical branch at message granularity: message ids ranked by bm25 + recency
/// (or recency alone when operators-only), best first, capped. Mirrors
/// `structured_thread_ids` but returns individual messages so RAG/agentic
/// callers can retrieve and cite specific emails.
fn structured_message_ids(conn: &Connection, q: &ParsedQuery, cap: i64) -> Result<Vec<i64>> {
    let mut where_clauses: Vec<String> = Vec::new();
    let mut bind: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

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

    append_operator_clauses(conn, q, &mut where_clauses, &mut bind)?;

    if where_clauses.is_empty() && q.fts.is_empty() {
        return Ok(Vec::new());
    }

    let rank_expr = if q.fts.is_empty() {
        "0.0"
    } else {
        "f.fts_rank"
    };
    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!("AND {}", where_clauses.join(" AND "))
    };

    let sql = format!(
        "{cte}
         SELECT m.id
         FROM messages m {fts_join}
         WHERE m.thread_id IS NOT NULL {where_sql}
         ORDER BY {rank_expr} ASC, m.date DESC
         LIMIT {cap}"
    );

    let mut stmt = conn.prepare_cached(&sql)?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let ids = stmt
        .query_map(params_ref.as_slice(), |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// The subset of `ids` (input order preserved) whose messages satisfy the
/// query's operator filters. Used to constrain semantic vector hits by
/// from:/to:/is:/etc. before fusing.
fn allowed_message_ids(conn: &Connection, q: &ParsedQuery, ids: &[i64]) -> Result<Vec<i64>> {
    let allowed = allowed_message_threads(conn, q, ids)?;
    Ok(ids
        .iter()
        .copied()
        .filter(|id| allowed.contains_key(id))
        .collect())
}

/// Message-level hybrid retrieval for RAG / agentic tools: fuse operator-aware
/// lexical (bm25) ids with the operator-filtered semantic hits via RRF, best
/// first, capped at `limit`. `vec_hits` are (message_id, score) from the vector
/// index; pass an empty slice for lexical-only.
pub fn message_hits(
    conn: &Connection,
    q: &ParsedQuery,
    vec_hits: &[(i64, f32)],
    limit: i64,
) -> Result<Vec<i64>> {
    let lexical = structured_message_ids(conn, q, candidate_cap(limit) as i64)?;

    let sem_ids: Vec<i64> = vec_hits.iter().map(|(id, _)| *id).collect();
    let allowed: HashSet<i64> = allowed_message_ids(conn, q, &sem_ids)?
        .into_iter()
        .collect();
    let semantic: Vec<i64> = sem_ids
        .into_iter()
        .filter(|id| allowed.contains(id))
        .collect();

    let lists: Vec<Vec<i64>> = [lexical, semantic]
        .into_iter()
        .filter(|l| !l.is_empty())
        .collect();
    let fused = rrf(&lists);
    Ok(fused
        .into_iter()
        .take(limit.max(1) as usize)
        .map(|(id, _)| id)
        .collect())
}

/// How many candidate thread ids each branch feeds into ranking for a given
/// result `limit`.
pub fn candidate_cap(limit: i64) -> usize {
    (limit.max(1) as usize * 4).clamp(50, 400)
}

/// Keyword candidates: `all` threads contain every query term (bm25 order);
/// `partial` threads contain only some of them (multi-term queries only),
/// excluding anything already in `all`.
#[derive(Debug, Default, Clone)]
pub struct Lexical {
    pub all: Vec<i64>,
    pub partial: Vec<i64>,
}

pub fn lexical_candidates(conn: &Connection, q: &ParsedQuery, cap: usize) -> Result<Lexical> {
    let all = structured_thread_ids(conn, q, cap as i64)?;
    let partial = if q.term_count > 1 && q.fts_or != q.fts {
        let seen: HashSet<i64> = all.iter().copied().collect();
        let mut relaxed = q.clone();
        relaxed.fts = q.fts_or.clone();
        structured_thread_ids(conn, &relaxed, cap as i64)?
            .into_iter()
            .filter(|id| !seen.contains(id))
            .collect()
    } else {
        Vec::new()
    };
    Ok(Lexical { all, partial })
}

/// Lexical thread ids: all-terms matches, or - when none - partial ones.
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
    append_operator_clauses(conn, q, &mut where_clauses, &mut bind)?;

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

/// Vector hits below this cosine similarity are noise, whatever their rank.
pub const SEMANTIC_MIN_SCORE: f32 = 0.58;
/// ...and so are hits far below the best one for this query.
pub const SEMANTIC_MAX_GAP: f32 = 0.08;

/// Semantic branch: fold message-level vector hits (already score-sorted) into
/// an operator-filtered, best-first, de-duplicated thread-id list, keeping only
/// hits close enough to the query to be meaningful.
fn vector_thread_ids(
    conn: &Connection,
    q: &ParsedQuery,
    vec_hits: &[(i64, f32)],
    cap: usize,
) -> Result<Vec<i64>> {
    let Some(&(_, top)) = vec_hits.first() else {
        return Ok(Vec::new());
    };
    let floor = SEMANTIC_MIN_SCORE.max(top - SEMANTIC_MAX_GAP);
    let kept: Vec<(i64, f32)> = vec_hits
        .iter()
        .copied()
        .filter(|(_, s)| *s >= floor)
        .collect();
    let ids: Vec<i64> = kept.iter().map(|(id, _)| *id).collect();
    let allowed = allowed_message_threads(conn, q, &ids)?;

    let mut seen = HashSet::new();
    let mut threads = Vec::new();
    for (mid, _score) in &kept {
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

/// Per-term sender match, each in [0, 1]. A name word equal to the term
/// counts fully ("be" → "Bé Dọn Dẹp"; with typed accents the accents must
/// agree for full credit), a name word it starts scores a little less, a
/// matching address part (the local part, split on `.`, `-`, `_`, `+`) less
/// again, and a mere substring weakly ("be" inside "noreply@bendover.com").
fn sender_term_scores(terms: &[String], raw_terms: &[String], name: &str, addr: &str) -> Vec<f32> {
    let name_raw = name.to_lowercase();
    let name_f = fold(name);
    let addr_f = fold(addr);
    let local = addr_f.split('@').next().unwrap_or("");
    let words = |s: &str| -> Vec<String> {
        s.split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(str::to_string)
            .collect()
    };
    let (raw_words, folded_words) = (words(&name_raw), words(&name_f));
    let local_parts: Vec<&str> = local.split(['.', '-', '_', '+']).collect();
    terms
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let r = raw_terms.get(i).map(String::as_str).unwrap_or(t.as_str());
            let accented = r != t.as_str();
            let t = t.as_str();
            if t.contains(' ') {
                // A phrase: the whole name contains it.
                return if (accented && name_raw.contains(r)) || (!accented && name_f.contains(t)) {
                    1.0
                } else if name_f.contains(t) {
                    0.8
                } else {
                    0.0
                };
            }
            if (accented && raw_words.iter().any(|w| w == r))
                || (!accented && folded_words.iter().any(|w| w == t))
            {
                1.0
            } else if folded_words.iter().any(|w| w == t) {
                0.8
            } else if folded_words.iter().any(|w| w.starts_with(t)) {
                if accented && !raw_words.iter().any(|w| w.starts_with(r)) {
                    0.5
                } else {
                    0.75
                }
            } else if local_parts.contains(&t) {
                0.85
            } else if local_parts.iter().any(|p| p.starts_with(t)) {
                0.7
            } else if name_f.contains(t) || addr_f.contains(t) {
                0.4
            } else {
                0.0
            }
        })
        .collect()
}

/// True when the free-text terms, as one phrase, appear contiguously in
/// `text` (accent-insensitive, punctuation ignored): "báo giá" in
/// "Re: Báo giá cho ..." but not in "Báo cáo ... giải pháp".
fn contains_phrase(terms: &[String], text: &str) -> bool {
    if terms.len() < 2 {
        return false;
    }
    let norm = |s: &str| -> String {
        let w: Vec<&str> = s
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .collect();
        format!(" {} ", w.join(" "))
    };
    let hay = norm(&fold(text));
    let needle = norm(&terms.join(" "));
    // Last word may be a prefix (still typing), so drop the trailing space.
    hay.contains(needle.trim_end())
}

/// Per-term subject match, each in [0, 1]. A whole word beats a word prefix
/// ("cert" → "Certificate"), and when the user typed accents, the exact
/// accented word beats one that only matches once diacritics are stripped
/// ("hùng": "Hùng" over "Hưng"). Phrases and tokens with punctuation
/// ("sal-qtn-2026") match as substrings.
fn subject_term_scores(terms: &[String], raw_terms: &[String], subject: &str) -> Vec<f32> {
    let raw = subject.to_lowercase();
    let folded = fold(subject);
    let words = |s: &str| -> Vec<String> {
        s.split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(str::to_string)
            .collect()
    };
    let (raw_words, folded_words) = (words(&raw), words(&folded));
    terms
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let r = raw_terms.get(i).map(String::as_str).unwrap_or(t.as_str());
            // Unaccented input matches accented text equally well; only accented
            // input asks for the accents to agree.
            let accented = r != t.as_str();
            if t.chars().any(|c| !c.is_alphanumeric()) {
                if (accented && raw.contains(r)) || (!accented && folded.contains(t.as_str())) {
                    1.0
                } else if folded.contains(t.as_str()) {
                    0.8
                } else {
                    0.0
                }
            } else if accented && raw_words.iter().any(|w| w == r) {
                1.0
            } else if folded_words.iter().any(|w| w == t) {
                if accented { 0.8 } else { 1.0 }
            } else if accented && raw_words.iter().any(|w| w.starts_with(r)) {
                0.7
            } else if folded_words.iter().any(|w| w.starts_with(t.as_str())) {
                if accented { 0.5 } else { 0.7 }
            } else {
                0.0
            }
        })
        .collect()
}

/// How strongly a subject matches the query's free-text terms, in [0, 1],
/// averaged over terms.
#[cfg(test)]
fn subject_match(terms: &[String], raw_terms: &[String], subject: &str) -> f32 {
    if terms.is_empty() {
        return 0.0;
    }
    subject_term_scores(terms, raw_terms, subject)
        .iter()
        .sum::<f32>()
        / terms.len() as f32
}

/// Why a thread is in the results, shown as a small tag on the row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchReason {
    /// Every term is in the subject.
    Subject,
    /// Every term is in the sender's name or address.
    Sender,
    /// Every term is in the mail, but not all in the subject/sender.
    Content,
    /// Only some of the terms are in the mail.
    Partial,
    /// No keyword match; the meaning is close (semantic search).
    Similar,
    /// Operator-only query; the thread passes the filters.
    Filter,
}

/// Ranking tiers, best first. A thread in a lower-numbered tier always ranks
/// above any thread in a higher one, whatever its other signals.
/// Every term is an exact word of the subject or sender.
pub const TIER_EXACT: u8 = 1;
/// Every term is in the subject or sender, some only as a word prefix or
/// with different accents.
pub const TIER_FIELDS: u8 = 2;
/// Every term is in the mail, not all in the subject/sender.
pub const TIER_CONTENT: u8 = 3;
/// Only some of the terms are in the mail.
pub const TIER_PARTIAL: u8 = 4;
/// Meaning-only (semantic) match.
pub const TIER_SIMILAR: u8 = 5;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub thread_id: i64,
    pub tier: u8,
    pub reason: MatchReason,
}

/// Ranked results: `threads` best first, with `hits` index-aligned.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub threads: Vec<ThreadSummary>,
    pub hits: Vec<SearchHit>,
    pub explain: SearchExplain,
}

/// Everything ranking needs to know about one candidate thread.
#[derive(Debug, Default)]
struct ThreadFacts {
    latest: i64,
    affinity: i64,
    replied: bool,
    starred: bool,
    user_label: bool,
    /// Every message is bulk/robot mail or in an auto category.
    automated: bool,
    senders: Vec<String>,
    /// The terms appear together, as typed, in a subject or sender name.
    phrase: bool,
    subject_terms: Vec<f32>,
    sender_terms: Vec<f32>,
}

fn thread_facts(
    conn: &Connection,
    q: &ParsedQuery,
    ids: &[i64],
) -> Result<HashMap<i64, ThreadFacts>> {
    let id_list = ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT m.thread_id, m.date,
                COALESCE(m.from_name, ''), COALESCE(m.from_addr, ''),
                COALESCE(c.send_count * 3 + c.recv_count, 0),
                COALESCE(m.subject, ''), m.is_outgoing, m.is_starred,
                m.is_automated
                  OR EXISTS (SELECT 1 FROM message_labels al JOIN labels l ON l.id = al.label_id
                             WHERE al.message_id = m.id AND l.is_auto = 1),
                EXISTS (SELECT 1 FROM message_labels ul JOIN labels l ON l.id = ul.label_id
                        WHERE ul.message_id = m.id AND l.is_auto = 0)
         FROM messages m
         LEFT JOIN contacts c ON c.email = LOWER(COALESCE(m.from_addr, ''))
         WHERE m.thread_id IN ({id_list})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, bool>(6)?,
            r.get::<_, bool>(7)?,
            r.get::<_, bool>(8)?,
            r.get::<_, bool>(9)?,
        ))
    })?;
    let n = q.terms.len();
    let mut facts: HashMap<i64, ThreadFacts> = HashMap::new();
    for row in rows {
        let (tid, date, name, addr, affinity, subject, outgoing, starred, automated, user_label) =
            row?;
        let f = facts.entry(tid).or_insert_with(|| ThreadFacts {
            latest: i64::MIN,
            automated: true,
            subject_terms: vec![0.0; n],
            sender_terms: vec![0.0; n],
            ..Default::default()
        });
        f.latest = f.latest.max(date);
        f.starred |= starred;
        f.user_label |= user_label;
        if outgoing {
            f.replied = true;
        } else {
            f.affinity = f.affinity.max(affinity);
            f.automated &= automated;
            let a = addr.to_lowercase();
            if !a.is_empty() && !f.senders.contains(&a) {
                f.senders.push(a);
            }
        }
        f.phrase |=
            contains_phrase(&q.terms, &subject) || (!outgoing && contains_phrase(&q.terms, &name));
        for (best, s) in
            f.subject_terms
                .iter_mut()
                .zip(subject_term_scores(&q.terms, &q.raw_terms, &subject))
        {
            *best = best.max(s);
        }
        if !outgoing {
            for (best, s) in f.sender_terms.iter_mut().zip(sender_term_scores(
                &q.terms,
                &q.raw_terms,
                &name,
                &addr,
            )) {
                *best = best.max(s);
            }
        }
    }
    Ok(facts)
}

/// Position-based score in (0, 1]: 1 for the first item, decaying gently.
fn rank_score(idx: Option<usize>) -> f32 {
    idx.map_or(0.0, |i| 1.0 / (1.0 + i as f32 * 0.1))
}

/// Rank keyword and semantic candidates into tiered results.
///
/// Order is lexicographic: tier first (all terms in subject/sender, then all
/// terms anywhere, then some terms, then meaning-only), so an exact keyword
/// match can never be outranked by a weaker one. Within a tier (or by date,
/// for `sort:` and operator-only queries):
///
/// `0.60·match + 0.28·personal + 0.12·recency`
///
/// - match: how well and where the terms matched (subject/sender quality,
///   bm25 position, agreement from semantic search)
/// - personal: what this user cares about - people they write to, threads
///   they replied in, starred/labelled mail, and what they've opened from
///   past searches; bulk/automated mail is discounted
/// - recency: fresher threads first, all else equal
pub fn rank(
    conn: &Connection,
    q: &ParsedQuery,
    lexical: Lexical,
    vec_hits: &[(i64, f32)],
    limit: i64,
    now_ms: i64,
) -> Result<SearchResults> {
    let semantic = vector_thread_ids(conn, q, vec_hits, candidate_cap(limit))?;
    let pos = |list: &[i64]| -> HashMap<i64, usize> {
        list.iter().enumerate().map(|(i, id)| (*id, i)).collect()
    };
    let (all_pos, partial_pos, sem_pos) =
        (pos(&lexical.all), pos(&lexical.partial), pos(&semantic));

    let mut seen = HashSet::new();
    let candidates: Vec<i64> = lexical
        .all
        .iter()
        .chain(&lexical.partial)
        .chain(&semantic)
        .copied()
        .filter(|id| seen.insert(*id))
        .collect();
    if candidates.is_empty() {
        return Ok(SearchResults::default());
    }

    let facts = thread_facts(conn, q, &candidates)?;
    let query_key = q.terms.join(" ");
    let thread_clicks =
        super::search_history::thread_scores(conn, &candidates, &query_key, now_ms)?;
    let sender_clicks = super::search_history::sender_scores(conn, now_ms)?;
    let keyword_query = !q.fts.is_empty();

    struct Scored {
        id: i64,
        tier: u8,
        reason: MatchReason,
        score: f32,
        latest: i64,
    }
    let mut scored: Vec<Scored> = Vec::with_capacity(candidates.len());
    for id in candidates {
        let Some(f) = facts.get(&id) else { continue };

        // Per term, the best of subject and sender. Subject hits are trimmed
        // slightly so a query that names a person ("be" → "Bé Dọn Dẹp")
        // prefers mail from them over mail merely using the word.
        let field_terms: Vec<f32> = f
            .subject_terms
            .iter()
            .zip(&f.sender_terms)
            .map(|(s, p)| (s * 0.9).max(*p))
            .collect();
        let n = field_terms.len().max(1) as f32;
        // A contiguous phrase is the strongest signal a multi-word query can
        // give; it lifts the match above the same words scattered around.
        let field_quality =
            (field_terms.iter().sum::<f32>() / n + if f.phrase { 0.3 } else { 0.0 }).min(1.3);
        let covered = |v: &[f32]| !v.is_empty() && v.iter().all(|s| *s >= 0.5);
        let exact = |v: &[f32]| !v.is_empty() && v.iter().all(|s| *s >= 0.85);

        let (tier, reason) = if !keyword_query {
            (TIER_EXACT, MatchReason::Filter)
        } else if all_pos.contains_key(&id) {
            // Exact words win over prefixes/accent variants, and the phrase
            // as typed counts as exact.
            let field_tier = if exact(&field_terms) || (f.phrase && covered(&field_terms)) {
                TIER_EXACT
            } else {
                TIER_FIELDS
            };
            let subject_hits = f.subject_terms.iter().filter(|s| **s >= 0.5).count();
            let sender_hits = f.sender_terms.iter().filter(|s| **s >= 0.5).count();
            if covered(&field_terms) {
                let reason = if sender_hits > subject_hits {
                    MatchReason::Sender
                } else {
                    MatchReason::Subject
                };
                (field_tier, reason)
            } else {
                (TIER_CONTENT, MatchReason::Content)
            }
        } else if partial_pos.contains_key(&id) {
            (TIER_PARTIAL, MatchReason::Partial)
        } else {
            (TIER_SIMILAR, MatchReason::Similar)
        };

        let lexical_rank = all_pos.get(&id).or_else(|| partial_pos.get(&id)).copied();
        let sem = rank_score(sem_pos.get(&id).copied());
        let matched = if tier == TIER_SIMILAR {
            sem
        } else {
            0.65 * field_quality + 0.25 * rank_score(lexical_rank) + 0.10 * sem
        };

        let affinity = f.affinity as f32;
        let thread_opens = thread_clicks.get(&id).copied().unwrap_or(0.0);
        let sender_opens = f
            .senders
            .iter()
            .filter_map(|s| sender_clicks.get(s))
            .fold(0.0f32, |a, b| a.max(*b));
        let personal = (0.30 * (affinity / (affinity + 25.0))
            + 0.20 * f32::from(u8::from(f.replied))
            + 0.10 * f32::from(u8::from(f.starred))
            + 0.05 * f32::from(u8::from(f.user_label))
            + 0.20 * (thread_opens / 2.0).min(1.0)
            + 0.15 * (sender_opens / (sender_opens + 3.0))
            - 0.25 * f32::from(u8::from(f.automated && !f.replied)))
        // Not clamped at 0: bulk mail from an unknown sender must still land
        // below a person nobody has scored yet.
        .clamp(-0.25, 1.0);

        let age_days = ((now_ms - f.latest).max(0) as f32) / 86_400_000.0;
        let recency = 1.0 / (1.0 + age_days / 30.0);

        scored.push(Scored {
            id,
            tier,
            reason,
            score: 0.60 * matched + 0.28 * personal + 0.12 * recency,
            latest: f.latest,
        });
    }

    // Operator-only queries have no relevance to speak of: newest first,
    // unless `sort:` says otherwise.
    let sort = match q.sort {
        Sort::Relevance if !keyword_query => Sort::Newest,
        s => s,
    };
    scored.sort_by(|a, b| {
        a.tier.cmp(&b.tier).then_with(|| match sort {
            Sort::Relevance => b.score.total_cmp(&a.score).then(b.latest.cmp(&a.latest)),
            Sort::Newest => b.latest.cmp(&a.latest),
            Sort::Oldest => a.latest.cmp(&b.latest),
        })
    });
    scored.truncate(limit.max(1) as usize);

    let order: Vec<i64> = scored.iter().map(|s| s.id).collect();
    let by_id: HashMap<i64, &Scored> = scored.iter().map(|s| (s.id, s)).collect();
    let threads = hydrate(conn, &order)?;
    let hits = threads
        .iter()
        .map(|t| {
            let s = by_id[&t.id];
            SearchHit {
                thread_id: t.id,
                tier: s.tier,
                reason: s.reason,
            }
        })
        .collect();
    Ok(SearchResults {
        threads,
        hits,
        explain: SearchExplain::default(),
    })
}

/// The explain payload for a query, with `label:` chips resolved against the
/// label table: a known label shows its real name, an unknown one becomes an
/// `unknown_label` warning with the closest existing name.
pub fn explain(conn: &Connection, q: &ParsedQuery) -> Result<SearchExplain> {
    let mut out = q.explain();
    let resolved = resolve_labels(conn, &q.label)?;
    if resolved.iter().any(Option::is_none) {
        let names: Vec<String> = super::labels::list(conn)?
            .into_iter()
            .map(|l| l.name)
            .collect();
        let keys: Vec<String> = names.iter().map(|n| label_key(n)).collect();
        let key_refs: Vec<&str> = keys.iter().map(String::as_str).collect();
        let mut label_chips = out
            .chips
            .iter()
            .enumerate()
            .filter(|(_, c)| c.kind == "label")
            .map(|(i, _)| i)
            .collect::<Vec<_>>()
            .into_iter();
        let mut drop = Vec::new();
        for r in &resolved {
            let Some(ci) = label_chips.next() else { break };
            if r.is_none() {
                let chip = &out.chips[ci];
                let suggestion = crate::search::closest(&label_key(&chip.value), &key_refs)
                    .and_then(|k| keys.iter().position(|x| x == k))
                    .map(|i| names[i].clone());
                out.warnings.push(crate::search::QueryWarning {
                    kind: "unknown_label",
                    token: chip.value.clone(),
                    suggestion,
                    start: chip.start,
                    end: chip.end,
                });
                drop.push(ci);
            }
        }
        for ci in drop.into_iter().rev() {
            out.chips.remove(ci);
        }
    }
    let mut names = resolved.into_iter().flatten().map(|(_, n)| n);
    for c in out.chips.iter_mut().filter(|c| c.kind == "label") {
        if let Some(n) = names.next() {
            c.value = n;
        }
    }
    Ok(out)
}

/// Lexical-only search (FTS5 bm25 + operator filters), grouped into threads.
/// Retained for callers that don't have a vector index.
pub fn search(conn: &Connection, q: &ParsedQuery, limit: i64) -> Result<Vec<ThreadSummary>> {
    let thread_ids = structured_thread_ids(conn, q, limit)?;
    hydrate(conn, &thread_ids)
}

/// Hybrid search: keyword candidates plus semantic (vector KNN) hits, ranked
/// by `rank`. `vec_hits` are (message_id, score) from the in-memory index,
/// score-sorted; pass an empty slice for keyword-only ranking.
pub fn hybrid(
    conn: &Connection,
    q: &ParsedQuery,
    vec_hits: &[(i64, f32)],
    limit: i64,
) -> Result<Vec<ThreadSummary>> {
    let lexical = lexical_candidates(conn, q, candidate_cap(limit))?;
    Ok(rank(
        conn,
        q,
        lexical,
        vec_hits,
        limit,
        chrono::Utc::now().timestamp_millis(),
    )?
    .threads)
}

fn hydrate(conn: &Connection, thread_ids: &[i64]) -> Result<Vec<ThreadSummary>> {
    // One IN query; get_summaries preserves the ranking order.
    super::threads::get_summaries(conn, thread_ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{repo::messages, testutil};

    /// hydrate() runs one IN query; it must return summaries in the fused
    /// ranking order it was given, skipping ids that no longer exist.
    #[test]
    fn hydrate_preserves_ranking_order() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (t1, _) = testutil::seed_message(&c, "a@test.dev", "Alpha", false);
        let (t2, _) = testutil::seed_message(&c, "b@test.dev", "Beta", false);
        let (t3, _) = testutil::seed_message(&c, "c@test.dev", "Gamma", false);

        let order = [t2, t3, t1];
        let out = hydrate(&c, &order).unwrap();
        assert_eq!(out.iter().map(|t| t.id).collect::<Vec<_>>(), order);

        // Reversed input, reversed output; missing ids are skipped.
        let out = hydrate(&c, &[t1, 9999, t3, t2]).unwrap();
        assert_eq!(out.iter().map(|t| t.id).collect::<Vec<_>>(), [t1, t3, t2]);
    }

    #[test]
    fn subject_match_prefers_whole_words_and_typed_accents() {
        let m = |query: &str, subject: &str| {
            let q = crate::search::parse(query);
            subject_match(&q.terms, &q.raw_terms, subject)
        };
        // Whole word beats a mere word prefix; absent scores zero.
        assert_eq!(m("certificate", "Your Certificate Has Been Revoked"), 1.0);
        assert!(m("cert", "Your Certificate Has Been Revoked") < 1.0);
        assert_eq!(m("certificate", "Unique Identity Reader"), 0.0);
        // Accented input prefers the exact accent; unaccented input doesn't care.
        assert!(m("hùng", "Hùng Thắng") > m("hùng", "Hưng Phú Automation"));
        assert_eq!(m("hung", "Hùng Thắng"), m("hung", "Hưng Phú Automation"));
        // Punctuated ids and phrases match as substrings.
        assert_eq!(
            m("SAL-QTN-2026-00371", "Quotation: SAL-QTN-2026-00371"),
            1.0
        );
        assert_eq!(m("\"báo giá\"", "Báo giá Retail Starter Kit"), 1.0);
        // Partial multi-term matches score in between.
        assert_eq!(
            m("renewal ovh", "Invoice available in the OVH Control Panel"),
            0.5
        );
    }

    /// A keyword in the subject outranks the same keyword buried in a body,
    /// even when the body-only thread is fresher.
    #[test]
    fn subject_hits_rank_above_fresher_body_only_hits() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (subj_thread, subj_msg) =
            testutil::seed_message(&c, "a@test.dev", "Your Certificate Has Been Revoked", false);
        index_message(&c, subj_msg).unwrap();
        let (body_thread, body_msg) =
            testutil::seed_message(&c, "b@test.dev", "Reader identity", false);
        messages::store_body(
            &c,
            body_msg,
            Some("each reader ships with a certificate"),
            None,
            None,
            false,
            Some("each reader ships with a certificate"),
        )
        .unwrap();
        index_message(&c, body_msg).unwrap();
        c.execute(
            "UPDATE messages SET date = ?1 WHERE id = ?2",
            params![chrono::Utc::now().timestamp_millis(), body_msg],
        )
        .unwrap();

        // The body-only thread also tops the semantic branch.
        let q = crate::search::parse("certificate");
        let out = hybrid(&c, &q, &[(body_msg, 0.9), (subj_msg, 0.5)], 20).unwrap();
        assert_eq!(
            out.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![subj_thread, body_thread]
        );
    }

    /// A thread that only the vector index thinks is relevant must never
    /// outrank one that actually contains the typed keyword, even when the
    /// semantic branch ranks it first.
    #[test]
    fn keyword_matches_rank_above_semantic_only_hits() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (kw_thread, kw_msg) =
            testutil::seed_message(&c, "a@test.dev", "zebrafinch invoice", false);
        index_message(&c, kw_msg).unwrap();
        let (sem_thread, sem_msg) =
            testutil::seed_message(&c, "b@test.dev", "billing statement", false);
        index_message(&c, sem_msg).unwrap();
        // Each branch ranks its own thread first, so RRF ties them; make the
        // semantic-only hit fresh so the recency boost alone would have put it
        // first (seeded messages are dated near the epoch).
        c.execute(
            "UPDATE messages SET date = ?1 WHERE id = ?2",
            params![chrono::Utc::now().timestamp_millis(), sem_msg],
        )
        .unwrap();

        let q = crate::search::parse("zebrafinch");
        let out = hybrid(&c, &q, &[(sem_msg, 0.99)], 20).unwrap();
        assert_eq!(
            out.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![kw_thread, sem_thread]
        );
    }

    #[test]
    fn trash_and_spam_are_hidden_unless_scoped() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        // A Trash folder to move the message into.
        c.execute(
            "INSERT INTO folders (id, account_id, imap_name, role) VALUES (5,1,'Trash','trash')",
            [],
        )
        .unwrap();
        let (thread_id, msg_id) =
            testutil::seed_message(&c, "sender@test.dev", "Hello there", false);
        let parse = crate::search::parse;
        let ids = |q: &str| {
            search(&c, &parse(q), 20)
                .unwrap()
                .iter()
                .map(|t| t.id)
                .collect::<Vec<_>>()
        };

        // In the inbox, a from: search finds it.
        assert_eq!(ids("from:sender"), vec![thread_id]);

        // Move it to Trash: the default search no longer returns it (so trashing
        // a result actually removes it from the list)...
        c.execute(
            "UPDATE messages SET folder_id = 5 WHERE id = ?1",
            params![msg_id],
        )
        .unwrap();
        assert!(ids("from:sender").is_empty());

        // ...but an explicit `in:trash` opts back in.
        assert_eq!(ids("in:trash from:sender"), vec![thread_id]);
    }

    #[test]
    fn subject_and_body_operators_scope_the_column() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        // Subject and body carry the two distinct words in opposite columns.
        let (thread_id, message_id) =
            testutil::seed_message(&c, "sender@test.dev", "quarterlyplan meeting", false);
        messages::store_body(
            &c,
            message_id,
            Some("budgetnumbers here"),
            None,
            None,
            false,
            Some("budgetnumbers here"),
        )
        .unwrap();
        index_message(&c, message_id).unwrap();

        let ids = |query: &str| lexical_thread_ids(&c, &crate::search::parse(query), 20).unwrap();
        // Column-scoped match hits when the word is in that column...
        assert_eq!(ids("subject:quarterlyplan"), vec![thread_id]);
        assert_eq!(ids("body:budgetnumbers"), vec![thread_id]);
        // ...and misses when the word lives in the other column.
        assert!(ids("subject:budgetnumbers").is_empty());
        assert!(ids("body:quarterlyplan").is_empty());
    }

    #[test]
    fn account_id_scopes_results_to_one_account() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        // Account 1: a thread matching "sharedterm".
        let (t1, m1) = testutil::seed_message(&c, "a@one.dev", "sharedterm alpha", false);
        index_message(&c, m1).unwrap();

        // Account 2 with its own inbox folder and a thread also matching "sharedterm".
        c.execute(
            "INSERT INTO accounts (id, email, provider, auth_kind, username,
             imap_host, imap_port, smtp_host, smtp_port, created_at)
             VALUES (2,'me2@test.dev','imap','password','me2','h',993,'h',587,0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO folders (id, account_id, imap_name, role) VALUES (2,2,'INBOX','inbox')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO threads (id, account_id, subject_norm, unread_count, last_message_at)
             VALUES (99, 2, 'sharedterm beta', 1, 1000)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO messages (thread_id, account_id, folder_id, uid, message_id, subject,
             from_addr, date, is_read, is_automated, is_draft, is_outgoing)
             VALUES (99, 2, 2, 99, 'mid-99', 'sharedterm beta', 'b@two.dev', 1000, 0, 0, 0, 0)",
            [],
        )
        .unwrap();
        let m2 = c.last_insert_rowid();
        index_message(&c, m2).unwrap();

        let ids = |account_id: Option<i64>| {
            let mut q = crate::search::parse("sharedterm");
            q.account_id = account_id;
            let mut out = lexical_thread_ids(&c, &q, 20).unwrap();
            out.sort();
            out
        };
        // No scope: both accounts' threads match.
        assert_eq!(ids(None), vec![t1, 99]);
        // Scoped: only the selected account's thread.
        assert_eq!(ids(Some(1)), vec![t1]);
        assert_eq!(ids(Some(2)), vec![99]);
    }

    #[test]
    fn reindex_removes_stale_contentless_fts_terms() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (_, message_id) = testutil::seed_message(&c, "sender@test.dev", "Subject", false);
        messages::store_body(
            &c,
            message_id,
            Some("obsoleteuniqueterm"),
            None,
            None,
            false,
            Some("obsoleteuniqueterm"),
        )
        .unwrap();
        index_message(&c, message_id).unwrap();
        messages::store_body(
            &c,
            message_id,
            Some("replacementuniqueterm"),
            None,
            None,
            false,
            Some("replacementuniqueterm"),
        )
        .unwrap();
        index_message(&c, message_id).unwrap();

        let matches = |term: &str| {
            c.query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH ?1",
                params![term],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
        };
        assert_eq!(matches("obsoleteuniqueterm"), 0);
        assert_eq!(matches("replacementuniqueterm"), 1);
    }
}
