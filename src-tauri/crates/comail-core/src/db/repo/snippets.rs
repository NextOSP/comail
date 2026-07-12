use crate::error::Result;
use crate::models::Snippet;
use rusqlite::{params, Connection, Row};

fn from_row(row: &Row) -> rusqlite::Result<Snippet> {
    Ok(Snippet {
        id: row.get("id")?,
        name: row.get("name")?,
        shortcut: row.get("shortcut")?,
        subject: row.get("subject")?,
        body_text: row.get("body_text")?,
        usage_count: row.get("usage_count")?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<Snippet>> {
    let mut stmt = conn.prepare("SELECT * FROM snippets ORDER BY usage_count DESC, name")?;
    let rows = stmt
        .query_map([], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn save(
    conn: &Connection,
    id: Option<i64>,
    name: &str,
    shortcut: Option<&str>,
    subject: Option<&str>,
    body_text: &str,
) -> Result<Snippet> {
    let id = match id {
        Some(id) => {
            conn.execute(
                "UPDATE snippets SET name=?2, shortcut=?3, subject=?4, body_text=?5 WHERE id=?1",
                params![id, name, shortcut, subject, body_text],
            )?;
            id
        }
        None => {
            conn.execute(
                "INSERT INTO snippets (name, shortcut, subject, body_text) VALUES (?1,?2,?3,?4)",
                params![name, shortcut, subject, body_text],
            )?;
            conn.last_insert_rowid()
        }
    };
    let mut stmt = conn.prepare("SELECT * FROM snippets WHERE id = ?1")?;
    Ok(stmt.query_row(params![id], from_row)?)
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn bump_usage(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE snippets SET usage_count = usage_count + 1 WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testutil;

    #[test]
    fn save_update_usage_delete_roundtrip() {
        let c = testutil::conn();
        let s = save(&c, None, "Intro", Some("intro"), Some("Hello"), "Hi there!").unwrap();
        assert_eq!(s.usage_count, 0);

        bump_usage(&c, s.id).unwrap();
        bump_usage(&c, s.id).unwrap();
        let listed = list(&c).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].usage_count, 2);

        let updated = save(&c, Some(s.id), "Intro 2", None, None, "Hey!").unwrap();
        assert_eq!(updated.name, "Intro 2");
        assert_eq!(updated.shortcut, None);
        // usage survives edits
        assert_eq!(updated.usage_count, 2);

        delete(&c, s.id).unwrap();
        assert!(list(&c).unwrap().is_empty());
    }
}
