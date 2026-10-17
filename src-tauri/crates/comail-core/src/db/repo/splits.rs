use crate::error::Result;
use crate::models::{AiCheck, RouteKey, RuleCondition, SplitRule, SplitRuleQuery};
use rusqlite::{Connection, OptionalExtension, Row, params};

fn from_row(row: &Row) -> rusqlite::Result<SplitRule> {
    let id: i64 = row.get("id")?;
    // A malformed condition falls back to the legacy query rather than to an
    // empty one, and is logged so it doesn't silently stop routing.
    let condition = row
        .get::<_, Option<String>>("condition_json")?
        .and_then(|json| match serde_json::from_str::<RuleCondition>(&json) {
            Ok(c) => Some(c),
            Err(e) => {
                tracing::warn!("split rule {id}: ignoring malformed condition_json: {e}");
                None
            }
        });
    let target = row
        .get::<_, Option<String>>("target")
        .unwrap_or(None)
        .and_then(|key| match key.parse::<RouteKey>() {
            Ok(k) => Some(k),
            Err(e) => {
                tracing::warn!("split rule {id}: {e}");
                None
            }
        });
    let ai = row
        .get::<_, Option<String>>("ai_json")
        .unwrap_or(None)
        .and_then(|json| match serde_json::from_str::<AiCheck>(&json) {
            Ok(a) if !a.instruction.trim().is_empty() => Some(a),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!("split rule {id}: ignoring malformed ai_json: {e}");
                None
            }
        });
    Ok(SplitRule {
        id,
        name: row.get("name")?,
        position: row.get("position")?,
        query: serde_json::from_str(&row.get::<_, String>("query_json")?).unwrap_or_default(),
        condition,
        target,
        ai,
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
    condition: Option<&RuleCondition>,
    target: Option<RouteKey>,
    ai: Option<&AiCheck>,
) -> Result<SplitRule> {
    let qjson = serde_json::to_string(query)?;
    let cjson = condition.map(serde_json::to_string).transpose()?;
    let ajson = ai
        .filter(|a| !a.instruction.trim().is_empty())
        .map(serde_json::to_string)
        .transpose()?;
    let target = target.map(|k| k.to_string());
    let id = match id {
        Some(id) => {
            conn.execute(
                "UPDATE split_rules SET name=?2, position=?3, query_json=?4, target=?5,
                 condition_json=?6, ai_json=?7 WHERE id=?1",
                params![id, name, position, qjson, target, cjson, ajson],
            )?;
            id
        }
        None => {
            conn.execute(
                "INSERT INTO split_rules (name, position, query_json, target, condition_json, ai_json)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![name, position, qjson, target, cjson, ajson],
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
    use crate::models::{SplitRuleQuery, TextOp};

    #[test]
    fn save_list_update_delete_roundtrip() {
        let c = testutil::conn();
        let q = SplitRuleQuery {
            senders: Some(vec!["@github.com".into()]),
            subject_contains: Some(vec!["ci".into()]),
            is_automated: Some(true),
            ..Default::default()
        };
        let a = save(
            &c,
            None,
            "GitHub",
            1,
            &q,
            None,
            Some(RouteKey::Label(3)),
            None,
        )
        .unwrap();
        let b = save(
            &c,
            None,
            "First",
            0,
            &SplitRuleQuery::default(),
            None,
            None,
            None,
        )
        .unwrap();

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
        assert_eq!(got.target, Some(RouteKey::Label(3)));
        assert!(got.condition.is_none());

        let updated = save(
            &c,
            Some(a.id),
            "GH",
            2,
            &SplitRuleQuery::default(),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(updated.name, "GH");
        assert!(updated.query.senders.is_none());
        assert_eq!(updated.target, None);

        delete(&c, a.id).unwrap();
        assert!(get(&c, a.id).unwrap().is_none());
    }

    #[test]
    fn condition_roundtrip_and_malformed_fallback() {
        let c = testutil::conn();
        let cond = RuleCondition::Any {
            of: vec![
                RuleCondition::Sender {
                    op: TextOp::EndsWith,
                    value: "@github.com".into(),
                },
                RuleCondition::Not {
                    cond: Box::new(RuleCondition::HasAttachment { value: true }),
                },
            ],
        };
        let q = SplitRuleQuery {
            senders: Some(vec!["legacy".into()]),
            ..Default::default()
        };
        let a = save(&c, None, "Typed", 0, &q, Some(&cond), None, None).unwrap();
        assert_eq!(a.condition.as_ref(), Some(&cond));
        assert_eq!(a.effective_condition(), cond);

        // Corrupt JSON: the rule keeps routing by its legacy query.
        c.execute(
            "UPDATE split_rules SET condition_json = '{\"kind\":\"nope\"}' WHERE id = ?1",
            params![a.id],
        )
        .unwrap();
        let got = get(&c, a.id).unwrap().unwrap();
        assert!(got.condition.is_none());
        assert_eq!(got.effective_condition(), RuleCondition::from(&q));
    }
}
