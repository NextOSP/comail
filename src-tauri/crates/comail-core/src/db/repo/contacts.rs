use crate::error::Result;
use crate::models::{Address, ContactSuggestion};
use crate::search::fold;
use rusqlite::{Connection, params};

/// Record an address seen in mail headers on `account_id`'s mail. `sent` = we
/// sent to them. A display name only replaces the stored one when `when_ms` is
/// at least as recent as the last interaction, so late-synced old mail can't
/// revert a rename. Updates both the global `contacts` row (identity + global
/// affinity used by search and sender_known) and the per-account
/// `contact_accounts` row that scopes compose autocomplete to the sending
/// account.
pub fn harvest(
    conn: &Connection,
    account_id: i64,
    addr: &Address,
    sent: bool,
    when_ms: i64,
) -> Result<()> {
    if addr.email.is_empty() || !addr.email.contains('@') {
        return Ok(());
    }
    let email = addr.email.to_lowercase();
    let name = addr.name.as_deref().unwrap_or("");
    let folded = fold(&format!("{} {}", name, addr.email));
    conn.execute(
        "INSERT INTO contacts (email, name, folded, send_count, recv_count, last_interacted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(email) DO UPDATE SET
            name = CASE WHEN NULLIF(excluded.name, '') IS NOT NULL AND (NULLIF(contacts.name, '') IS NULL OR ?6 >= COALESCE(contacts.last_interacted, 0)) THEN excluded.name ELSE contacts.name END,
            folded = CASE
                WHEN NULLIF(excluded.name, '') IS NOT NULL AND (NULLIF(contacts.name, '') IS NULL OR ?6 >= COALESCE(contacts.last_interacted, 0)) OR contacts.folded IS NULL
                THEN excluded.folded ELSE contacts.folded END,
            send_count = contacts.send_count + ?4,
            recv_count = contacts.recv_count + ?5,
            last_interacted = MAX(COALESCE(contacts.last_interacted, 0), ?6)",
        params![email, name, folded, sent as i64, (!sent) as i64, when_ms],
    )?;
    conn.execute(
        "INSERT INTO contact_accounts (contact_id, account_id, send_count, recv_count, last_interacted)
         SELECT id, ?2, ?3, ?4, ?5 FROM contacts WHERE email = ?1
         ON CONFLICT(contact_id, account_id) DO UPDATE SET
            send_count = contact_accounts.send_count + ?3,
            recv_count = contact_accounts.recv_count + ?4,
            last_interacted = MAX(COALESCE(contact_accounts.last_interacted, 0), ?5)",
        params![email, account_id, sent as i64, (!sent) as i64, when_ms],
    )?;
    Ok(())
}

/// One-time fill of `contacts.folded` for rows harvested before the column
/// existed. Cheap no-op once every row is folded.
pub fn backfill_folded(conn: &Connection) -> Result<()> {
    let mut stmt =
        conn.prepare("SELECT id, COALESCE(name,''), email FROM contacts WHERE folded IS NULL")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, name, email) in rows {
        conn.execute(
            "UPDATE contacts SET folded = ?1 WHERE id = ?2",
            params![fold(&format!("{name} {email}")), id],
        )?;
    }
    Ok(())
}

/// Escape LIKE wildcards so a literal % or _ in the query can't scan-match.
fn like_escape(tok: &str) -> String {
    tok.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Build the WHERE fragment requiring every folded query token to appear in
/// `contacts.folded`, pushing one `%tok%` bind per token. Returns None for
/// queries with no usable tokens.
fn folded_clauses(query: &str, bind: &mut Vec<Box<dyn rusqlite::types::ToSql>>) -> Option<String> {
    let folded = fold(query);
    let tokens: Vec<&str> = folded.split_whitespace().collect();
    if tokens.is_empty() {
        return None;
    }
    let mut clauses = Vec::with_capacity(tokens.len());
    for tok in tokens {
        bind.push(Box::new(format!("%{}%", like_escape(tok))));
        clauses.push(format!(
            "COALESCE(folded, email) LIKE ?{} ESCAPE '\\'",
            bind.len()
        ));
    }
    Some(clauses.join(" AND "))
}

/// Days over which interaction history loses half its weight. Keeps a long
/// history from pinning an address someone stopped using above the one they
/// use now.
const RECENCY_HALF_LIFE_DAYS: f64 = 30.0;

/// Contacts matching every query token (accent- and case-insensitive), ranked
/// by interaction affinity - people you actually email float to the top. When
/// `account_id` is Some, only contacts that account has corresponded with are
/// returned, ranked by that account's affinity; None searches all contacts.
///
/// Ranking: contacts where the first query token starts a word (name or email)
/// come before mid-word matches; within those, affinity (`send*3 + recv`) is
/// damped by age so recent correspondence wins. Addresses sharing a display
/// name (one person, changed address) are kept together at the best member's
/// position, most recently used first.
pub fn suggest(
    conn: &Connection,
    query: &str,
    account_id: Option<i64>,
    limit: i64,
) -> Result<Vec<ContactSuggestion>> {
    suggest_at(conn, query, account_id, limit, crate::models::now_ms())
}

fn suggest_at(
    conn: &Connection,
    query: &str,
    account_id: Option<i64>,
    limit: i64,
    now_ms: i64,
) -> Result<Vec<ContactSuggestion>> {
    let mut bind: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let Some(where_sql) = folded_clauses(query, &mut bind) else {
        return Ok(Vec::new());
    };
    let first = fold(query)
        .split_whitespace()
        .next()
        .map(like_escape)
        .unwrap_or_default();
    bind.push(Box::new(format!("{first}%")));
    let starts_ix = bind.len();
    bind.push(Box::new(format!("% {first}%")));
    let word_ix = bind.len();
    bind.push(Box::new(now_ms));
    let now_ix = bind.len();
    // `contact_accounts` has no name/email/folded columns, so the folded WHERE
    // clause stays unambiguous; only the affinity columns get an alias.
    let (stats, from) = if let Some(aid) = account_id {
        bind.push(Box::new(aid));
        (
            "ca",
            format!(
                "contacts c JOIN contact_accounts ca
                   ON ca.contact_id = c.id AND ca.account_id = ?{}",
                bind.len()
            ),
        )
    } else {
        ("c", "contacts c".to_string())
    };
    // Over-fetch so name grouping below still fills `limit`.
    bind.push(Box::new(limit.saturating_mul(3)));
    let sql = format!(
        "SELECT c.name, c.email, {stats}.send_count * 3 + {stats}.recv_count,
                COALESCE({stats}.last_interacted, 0)
         FROM {from}
         WHERE {where_sql}
         ORDER BY (COALESCE(c.folded, c.email) LIKE ?{starts_ix} ESCAPE '\\'
                   OR COALESCE(c.folded, c.email) LIKE ?{word_ix} ESCAPE '\\'
                   OR c.email LIKE ?{starts_ix} ESCAPE '\\') DESC,
                  ({stats}.send_count * 3 + {stats}.recv_count) * {RECENCY_HALF_LIFE_DAYS}
                    / ({RECENCY_HALF_LIFE_DAYS}
                       + MAX(0, ?{now_ix} - COALESCE({stats}.last_interacted, 0)) / 86400000.0) DESC,
                  {stats}.last_interacted DESC
         LIMIT ?{}",
        bind.len()
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(params_ref.as_slice(), |r| {
            Ok((
                ContactSuggestion {
                    name: r.get(0)?,
                    email: r.get(1)?,
                    interactions: r.get(2)?,
                },
                r.get::<_, i64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(group_by_name(rows, limit))
}

/// A suggestion plus its `last_interacted` (ms).
type RankedHit = (ContactSuggestion, i64);

/// Keep addresses with the same display name together at the position of the
/// best-ranked one, newest first, so a person's current address shows above
/// the one they used to have. Rows without a name stand alone.
fn group_by_name(rows: Vec<RankedHit>, limit: i64) -> Vec<ContactSuggestion> {
    let mut groups: Vec<(Option<String>, Vec<RankedHit>)> = Vec::new();
    for (hit, last) in rows {
        let key = hit
            .name
            .as_deref()
            .map(|n| fold(n).split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|k| !k.is_empty());
        match key
            .as_ref()
            .and_then(|k| groups.iter_mut().find(|(g, _)| g.as_ref() == Some(k)))
        {
            Some((_, members)) => members.push((hit, last)),
            None => groups.push((key, vec![(hit, last)])),
        }
    }
    groups
        .into_iter()
        .flat_map(|(_, mut members)| {
            // Stable sort: equal timestamps keep their affinity order.
            members.sort_by_key(|m| std::cmp::Reverse(m.1));
            members.into_iter().map(|(hit, _)| hit)
        })
        .take(limit.max(0) as usize)
        .collect()
}

pub fn autocomplete(
    conn: &Connection,
    prefix: &str,
    account_id: Option<i64>,
    limit: i64,
) -> Result<Vec<Address>> {
    Ok(suggest(conn, prefix, account_id, limit)?
        .into_iter()
        .map(|c| Address {
            name: c.name,
            email: c.email,
        })
        .collect())
}

/// Affinity score (send_count*3 + recv_count) per email, for the given
/// lowercase addresses. Used to personalize search ranking.
pub fn affinity_for(
    conn: &Connection,
    emails: &[String],
) -> Result<std::collections::HashMap<String, i64>> {
    let mut out = std::collections::HashMap::new();
    if emails.is_empty() {
        return Ok(out);
    }
    let placeholders = (1..=emails.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT email, send_count * 3 + recv_count FROM contacts WHERE email IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = emails
        .iter()
        .map(|e| e as &dyn rusqlite::types::ToSql)
        .collect();
    let rows = stmt.query_map(params_ref.as_slice(), |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    for row in rows {
        let (email, score) = row?;
        out.insert(email, score);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testutil;
    use crate::models::Address;

    fn addr(email: &str, name: Option<&str>) -> Address {
        Address {
            name: name.map(str::to_string),
            email: email.into(),
        }
    }

    #[test]
    fn harvest_counts_and_autocomplete() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        harvest(&c, 1, &addr("alice@acme.com", Some("Alice")), true, 100).unwrap();
        harvest(&c, 1, &addr("alice@acme.com", None), true, 200).unwrap();
        harvest(&c, 1, &addr("bob@other.org", Some("Bob")), false, 150).unwrap();

        let (send, recv): (i64, i64) = c
            .query_row(
                "SELECT send_count, recv_count FROM contacts WHERE email = 'alice@acme.com'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((send, recv), (2, 0));

        let hits = autocomplete(&c, "ali", None, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].email, "alice@acme.com");
        // harvested name survives even when a later sighting had none
        assert_eq!(hits[0].name.as_deref(), Some("Alice"));

        assert!(autocomplete(&c, "zzz", None, 10).unwrap().is_empty());
    }

    #[test]
    fn autocomplete_scopes_to_account() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        c.execute(
            "INSERT INTO accounts (id, email, provider, auth_kind, username,
             imap_host, imap_port, smtp_host, smtp_port, created_at)
             VALUES (2,'two@test.dev','imap','password','two','h',993,'h',587,0)",
            [],
        )
        .unwrap();
        // alice belongs to account 1, carol to account 2.
        harvest(&c, 1, &addr("alice@acme.com", Some("Alice")), true, 100).unwrap();
        harvest(&c, 2, &addr("carol@acme.com", Some("Carol")), true, 100).unwrap();

        // Account-scoped: each account only sees its own contact.
        let a1 = autocomplete(&c, "a", Some(1), 10).unwrap();
        assert_eq!(
            a1.iter().map(|h| h.email.as_str()).collect::<Vec<_>>(),
            ["alice@acme.com"]
        );
        let a2 = autocomplete(&c, "a", Some(2), 10).unwrap();
        assert_eq!(
            a2.iter().map(|h| h.email.as_str()).collect::<Vec<_>>(),
            ["carol@acme.com"]
        );

        // Global (view-all): both surface.
        let all = autocomplete(&c, "a", None, 10).unwrap();
        assert_eq!(all.len(), 2);
    }

    const DAY: i64 = 86_400_000;

    fn emails(hits: &[ContactSuggestion]) -> Vec<&str> {
        hits.iter().map(|h| h.email.as_str()).collect()
    }

    #[test]
    fn recent_sends_outrank_old_history() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let now = 400 * DAY;
        // Lots of mail from an old colleague a year ago...
        for _ in 0..20 {
            harvest(
                &c,
                1,
                &addr("bao.old@acme.com", Some("Bao Tran")),
                false,
                now - 365 * DAY,
            )
            .unwrap();
        }
        // ...versus a few sends this week to someone else.
        for _ in 0..3 {
            harvest(
                &c,
                1,
                &addr("bao.new@acme.com", Some("Bao Nguyen")),
                true,
                now - DAY,
            )
            .unwrap();
        }
        let hits = suggest_at(&c, "bao", Some(1), 10, now).unwrap();
        assert_eq!(emails(&hits), ["bao.new@acme.com", "bao.old@acme.com"]);
    }

    #[test]
    fn changed_address_lists_newest_first() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let now = 400 * DAY;
        for _ in 0..50 {
            harvest(
                &c,
                1,
                &addr("bao.chiluu@acme.com", Some("Bao Luu")),
                true,
                now - 200 * DAY,
            )
            .unwrap();
        }
        harvest(
            &c,
            1,
            &addr("bao.luuchi@acme.com", Some("Bao Luu")),
            true,
            now - DAY,
        )
        .unwrap();
        // Unrelated contact ranked between them by score alone.
        for _ in 0..5 {
            harvest(
                &c,
                1,
                &addr("bao.pham@acme.com", Some("Bao Pham")),
                true,
                now - 10 * DAY,
            )
            .unwrap();
        }
        let hits = suggest_at(&c, "bao", Some(1), 10, now).unwrap();
        assert_eq!(
            emails(&hits),
            [
                "bao.luuchi@acme.com",
                "bao.chiluu@acme.com",
                "bao.pham@acme.com"
            ]
        );
    }

    #[test]
    fn older_mail_does_not_revert_a_rename() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        harvest(
            &c,
            1,
            &addr("bao@acme.com", Some("Bao Luu Chi")),
            false,
            500,
        )
        .unwrap();
        harvest(
            &c,
            1,
            &addr("bao@acme.com", Some("Bao Chi Luu")),
            false,
            100,
        )
        .unwrap();
        let hits = autocomplete(&c, "bao", None, 10).unwrap();
        assert_eq!(hits[0].name.as_deref(), Some("Bao Luu Chi"));
        // A newer sighting does rename.
        harvest(&c, 1, &addr("bao@acme.com", Some("Bao L. Chi")), false, 900).unwrap();
        let hits = autocomplete(&c, "l. chi", None, 10).unwrap();
        assert_eq!(hits[0].name.as_deref(), Some("Bao L. Chi"));
    }

    #[test]
    fn word_start_match_outranks_mid_word_match() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        // Mid-word "an" with far more traffic still sorts below a word start.
        for _ in 0..10 {
            harvest(&c, 1, &addr("joan@acme.com", Some("Joan")), true, 100).unwrap();
        }
        harvest(&c, 1, &addr("anna@acme.com", Some("Anna")), true, 100).unwrap();
        let hits = suggest_at(&c, "an", Some(1), 10, 100).unwrap();
        assert_eq!(emails(&hits), ["anna@acme.com", "joan@acme.com"]);
    }
}
