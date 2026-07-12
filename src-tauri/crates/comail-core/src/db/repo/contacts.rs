use crate::error::Result;
use crate::models::{Address, ContactSuggestion};
use crate::search::fold;
use rusqlite::{params, Connection};

/// Record an address seen in mail headers. `sent` = we sent to them.
pub fn harvest(conn: &Connection, addr: &Address, sent: bool, when_ms: i64) -> Result<()> {
    if addr.email.is_empty() || !addr.email.contains('@') {
        return Ok(());
    }
    let name = addr.name.as_deref().unwrap_or("");
    let folded = fold(&format!("{} {}", name, addr.email));
    conn.execute(
        "INSERT INTO contacts (email, name, folded, send_count, recv_count, last_interacted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(email) DO UPDATE SET
            name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
            folded = CASE
                WHEN NULLIF(excluded.name, '') IS NOT NULL OR contacts.folded IS NULL
                THEN excluded.folded ELSE contacts.folded END,
            send_count = contacts.send_count + ?4,
            recv_count = contacts.recv_count + ?5,
            last_interacted = MAX(COALESCE(contacts.last_interacted, 0), ?6)",
        params![
            addr.email.to_lowercase(),
            name,
            folded,
            sent as i64,
            (!sent) as i64,
            when_ms
        ],
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

/// Build the WHERE fragment requiring every folded query token to appear in
/// `contacts.folded`, pushing one `%tok%` bind per token. Returns None for
/// queries with no usable tokens.
fn folded_clauses(
    query: &str,
    bind: &mut Vec<Box<dyn rusqlite::types::ToSql>>,
) -> Option<String> {
    let folded = fold(query);
    let tokens: Vec<&str> = folded.split_whitespace().collect();
    if tokens.is_empty() {
        return None;
    }
    let mut clauses = Vec::with_capacity(tokens.len());
    for tok in tokens {
        // Escape LIKE wildcards so a literal % or _ in the query can't scan-match.
        let esc = tok.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        bind.push(Box::new(format!("%{esc}%")));
        clauses.push(format!("COALESCE(folded, email) LIKE ?{} ESCAPE '\\'", bind.len()));
    }
    Some(clauses.join(" AND "))
}

/// Contacts matching every query token (accent- and case-insensitive), ranked
/// by interaction affinity - people you actually email float to the top.
pub fn suggest(conn: &Connection, query: &str, limit: i64) -> Result<Vec<ContactSuggestion>> {
    let mut bind: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let Some(where_sql) = folded_clauses(query, &mut bind) else {
        return Ok(Vec::new());
    };
    bind.push(Box::new(limit));
    let sql = format!(
        "SELECT name, email, send_count * 3 + recv_count FROM contacts
         WHERE {where_sql}
         ORDER BY (send_count * 3 + recv_count) DESC, last_interacted DESC
         LIMIT ?{}",
        bind.len()
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(params_ref.as_slice(), |r| {
            Ok(ContactSuggestion {
                name: r.get(0)?,
                email: r.get(1)?,
                interactions: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn autocomplete(conn: &Connection, prefix: &str, limit: i64) -> Result<Vec<Address>> {
    Ok(suggest(conn, prefix, limit)?
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
    let params_ref: Vec<&dyn rusqlite::types::ToSql> =
        emails.iter().map(|e| e as &dyn rusqlite::types::ToSql).collect();
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
        harvest(&c, &addr("alice@acme.com", Some("Alice")), true, 100).unwrap();
        harvest(&c, &addr("alice@acme.com", None), true, 200).unwrap();
        harvest(&c, &addr("bob@other.org", Some("Bob")), false, 150).unwrap();

        let (send, recv): (i64, i64) = c
            .query_row(
                "SELECT send_count, recv_count FROM contacts WHERE email = 'alice@acme.com'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((send, recv), (2, 0));

        let hits = autocomplete(&c, "ali", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].email, "alice@acme.com");
        // harvested name survives even when a later sighting had none
        assert_eq!(hits[0].name.as_deref(), Some("Alice"));

        assert!(autocomplete(&c, "zzz", 10).unwrap().is_empty());
    }
}
