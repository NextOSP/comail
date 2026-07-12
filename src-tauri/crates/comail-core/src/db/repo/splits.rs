use crate::error::Result;
use crate::models::{SplitRule, SplitRuleQuery};
use rusqlite::{params, Connection, OptionalExtension, Row};

fn from_row(row: &Row) -> rusqlite::Result<SplitRule> {
    Ok(SplitRule {
        id: row.get("id")?,
        name: row.get("name")?,
        position: row.get("position")?,
        query: serde_json::from_str(&row.get::<_, String>("query_json")?).unwrap_or_default(),
    })
}

pub fn list(conn: &Connection) -> Result<Vec<SplitRule>> {
    let mut stmt = conn.prepare("SELECT * FROM split_rules ORDER BY position, id")?;
    let rows = stmt
        .query_map([], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<SplitRule>> {
    let mut stmt = conn.prepare("SELECT * FROM split_rules WHERE id = ?1")?;
    Ok(stmt.query_row(params![id], from_row).optional()?)
}

pub fn save(
    conn: &Connection,
    id: Option<i64>,
    name: &str,
    position: i64,
    query: &SplitRuleQuery,
) -> Result<SplitRule> {
    let qjson = serde_json::to_string(query)?;
    let id = match id {
        Some(id) => {
            conn.execute(
                "UPDATE split_rules SET name=?2, position=?3, query_json=?4 WHERE id=?1",
                params![id, name, position, qjson],
            )?;
            id
        }
        None => {
            conn.execute(
                "INSERT INTO split_rules (name, position, query_json) VALUES (?1,?2,?3)",
                params![name, position, qjson],
            )?;
            conn.last_insert_rowid()
        }
    };
    let mut stmt = conn.prepare("SELECT * FROM split_rules WHERE id = ?1")?;
    Ok(stmt.query_row(params![id], from_row)?)
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM split_rules WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testutil;
    use crate::models::SplitRuleQuery;

    #[test]
    fn save_list_update_delete_roundtrip() {
        let c = testutil::conn();
        let q = SplitRuleQuery {
            senders: Some(vec!["@github.com".into()]),
            subject_contains: Some(vec!["ci".into()]),
            is_automated: Some(true),
        };
        let a = save(&c, None, "GitHub", 1, &q).unwrap();
        let b = save(&c, None, "First", 0, &SplitRuleQuery::default()).unwrap();

        // ordered by position
        let listed = list(&c).unwrap();
        assert_eq!(
            listed.iter().map(|s| s.id).collect::<Vec<_>>(),
            vec![b.id, a.id]
        );

        // query JSON survives the roundtrip
        let got = get(&c, a.id).unwrap().unwrap();
        assert_eq!(
            got.query.senders.as_deref(),
            Some(&["@github.com".to_string()][..])
        );
        assert_eq!(got.query.is_automated, Some(true));

        let updated = save(&c, Some(a.id), "GH", 2, &SplitRuleQuery::default()).unwrap();
        assert_eq!(updated.name, "GH");
        assert!(updated.query.senders.is_none());

        delete(&c, a.id).unwrap();
        assert!(get(&c, a.id).unwrap().is_none());
    }
}
