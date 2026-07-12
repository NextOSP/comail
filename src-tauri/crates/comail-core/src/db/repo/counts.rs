//! Exact unread counts for split tabs and sidebar rows: a handful of scalar
//! COUNT queries sharing the predicate shapes of `threads::list`. Kept out of
//! threads.rs so the two evolve independently.

use crate::error::Result;
use crate::models::{roles, Label, SplitRule, SplitRuleQuery, UnreadCounts};
use rusqlite::Connection;
use std::collections::HashMap;

/// Composable COUNT(*) query over threads (+ snoozes join, like SUMMARY_SELECT).
struct Q {
    clauses: Vec<String>,
    bind: Vec<Box<dyn rusqlite::types::ToSql>>,
}

impl Q {
    /// Base: threads with unread messages, optionally account-scoped.
    fn unread(account_id: Option<i64>) -> Self {
        let mut q = Q {
            clauses: vec!["t.unread_count > 0".into()],
            bind: Vec::new(),
        };
        if let Some(acc) = account_id {
            q.bind.push(Box::new(acc));
            q.clauses.push(format!("t.account_id = ?{}", q.bind.len()));
        }
        q
    }

    /// Same base without the unread filter (drafts badge counts all drafts).
    fn any(account_id: Option<i64>) -> Self {
        let mut q = Q {
            clauses: Vec::new(),
            bind: Vec::new(),
        };
        if let Some(acc) = account_id {
            q.bind.push(Box::new(acc));
            q.clauses.push(format!("t.account_id = ?{}", q.bind.len()));
        }
        q
    }

    fn clause(mut self, c: impl Into<String>) -> Self {
        self.clauses.push(c.into());
        self
    }

    fn role_exists(&mut self, role: &str) -> String {
        self.bind.push(Box::new(role.to_string()));
        format!(
            "EXISTS (SELECT 1 FROM messages m JOIN folders f ON f.id = m.folder_id
                     WHERE m.thread_id = t.id AND f.role = ?{})",
            self.bind.len()
        )
    }

    fn inbox(mut self) -> Self {
        let c = self.role_exists(roles::INBOX);
        self.clauses.push(c);
        self.clauses.push("s.thread_id IS NULL".into());
        self
    }

    /// Mirrors the split-query SQL in `threads::list`.
    fn split(mut self, q: &SplitRuleQuery) -> Self {
        if let Some(auto) = q.is_automated {
            let cmp = if auto { "1" } else { "0" };
            self.clauses.push(format!(
                "EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id
                         AND m.is_draft = 0 AND m.is_outgoing = 0
                         AND m.is_automated = {cmp})
                 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id
                         AND m.is_draft = 0 AND m.is_outgoing = 0
                         AND m.is_automated = {})",
                if auto { "0" } else { "1" }
            ));
        }
        if let Some(senders) = &q.senders {
            if !senders.is_empty() {
                let mut ors = Vec::new();
                for s in senders {
                    self.bind.push(Box::new(format!("%{}%", s.to_lowercase())));
                    ors.push(format!(
                        "EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id
                                 AND LOWER(m.from_addr) LIKE ?{})",
                        self.bind.len()
                    ));
                }
                self.clauses.push(format!("({})", ors.join(" OR ")));
            }
        }
        if let Some(subs) = &q.subject_contains {
            if !subs.is_empty() {
                let mut ors = Vec::new();
                for s in subs {
                    self.bind.push(Box::new(format!("%{}%", s.to_lowercase())));
                    ors.push(format!("LOWER(t.subject_norm) LIKE ?{}", self.bind.len()));
                }
                self.clauses.push(format!("({})", ors.join(" OR ")));
            }
        }
        self
    }

    fn label(mut self, label_id: i64) -> Self {
        self.bind.push(Box::new(label_id));
        self.clauses.push(format!(
            "EXISTS (SELECT 1 FROM message_labels ml JOIN messages m ON m.id = ml.message_id
                     WHERE m.thread_id = t.id AND ml.label_id = ?{})",
            self.bind.len()
        ));
        self
    }

    fn run(self, conn: &Connection) -> Result<i64> {
        let where_sql = if self.clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", self.clauses.join(" AND "))
        };
        let sql = format!(
            "SELECT COUNT(*) FROM threads t LEFT JOIN snoozes s ON s.thread_id = t.id {where_sql}"
        );
        let params: Vec<&dyn rusqlite::types::ToSql> = self.bind.iter().map(|b| b.as_ref()).collect();
        Ok(conn.query_row(&sql, params.as_slice(), |r| r.get(0))?)
    }
}

fn automated(flag: bool) -> SplitRuleQuery {
    SplitRuleQuery {
        is_automated: Some(flag),
        ..Default::default()
    }
}

pub fn unread_counts(
    conn: &Connection,
    account_id: Option<i64>,
    splits: &[SplitRule],
    labels: &[Label],
) -> Result<UnreadCounts> {
    let inbox = Q::unread(account_id).inbox().run(conn)?;
    let important = Q::unread(account_id).inbox().split(&automated(false)).run(conn)?;
    let other = Q::unread(account_id).inbox().split(&automated(true)).run(conn)?;

    let mut splits_map = HashMap::new();
    for sp in splits {
        let n = Q::unread(account_id).inbox().split(&sp.query).run(conn)?;
        splits_map.insert(sp.id.to_string(), n);
    }

    let mut labels_map = HashMap::new();
    for l in labels {
        let n = Q::unread(account_id).inbox().label(l.id).run(conn)?;
        labels_map.insert(l.id.to_string(), n);
    }

    let mut views = HashMap::new();
    views.insert(
        "starred".to_string(),
        Q::unread(account_id).clause("t.starred_count > 0").run(conn)?,
    );
    views.insert(
        "snoozed".to_string(),
        Q::unread(account_id).clause("s.thread_id IS NOT NULL").run(conn)?,
    );
    // Drafts badge = number of threads with a draft, unread or not.
    views.insert(
        "drafts".to_string(),
        Q::any(account_id)
            .clause("EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.is_draft = 1)")
            .run(conn)?,
    );

    Ok(UnreadCounts {
        inbox,
        important,
        other,
        splits: splits_map,
        labels: labels_map,
        views,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn test_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO accounts (id, email, provider, auth_kind, username,
             imap_host, imap_port, smtp_host, smtp_port, created_at)
             VALUES (1,'t@x.com','imap','password','t','h',993,'h',587,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folders (id, account_id, imap_name, role) VALUES (1,1,'INBOX','inbox')",
            [],
        )
        .unwrap();
        conn
    }

    fn seed_thread(conn: &Connection, id: i64, unread: i64, automated: bool) {
        conn.execute(
            "INSERT INTO threads (id, account_id, subject_norm, unread_count, last_message_at)
             VALUES (?1, 1, 'subj', ?2, 1000)",
            params![id, unread],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (thread_id, account_id, folder_id, uid, message_id, subject,
             from_addr, date, is_read, is_automated, is_draft, is_outgoing)
             VALUES (?1, 1, 1, ?1, 'mid-' || ?1, 'subj', 'a@b.c', 1000, ?2, ?3, 0, 0)",
            params![id, (unread == 0) as i64, automated as i64],
        )
        .unwrap();
    }

    #[test]
    fn partitions_important_and_other() {
        let conn = test_db();
        seed_thread(&conn, 1, 1, false); // unread human
        seed_thread(&conn, 2, 1, true); // unread automated
        seed_thread(&conn, 3, 0, true); // read automated

        let c = unread_counts(&conn, None, &[], &[]).unwrap();
        assert_eq!(c.inbox, 2);
        assert_eq!(c.important, 1);
        assert_eq!(c.other, 1);
        assert_eq!(c.views["starred"], 0);

        // account filter that matches nothing
        let none = unread_counts(&conn, Some(99), &[], &[]).unwrap();
        assert_eq!(none.inbox, 0);
    }

    #[test]
    fn split_and_label_maps() {
        let conn = test_db();
        seed_thread(&conn, 1, 1, false);
        conn.execute(
            "INSERT INTO labels (id, name, color, keyword, position) VALUES (5,'L','#fff','KwL',0)",
            [],
        )
        .unwrap();
        let msg_id: i64 = conn
            .query_row("SELECT id FROM messages WHERE thread_id = 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO message_labels (message_id, label_id) VALUES (?1, 5)",
            params![msg_id],
        )
        .unwrap();

        let split = SplitRule {
            id: 7,
            name: "s".into(),
            position: 0,
            query: SplitRuleQuery {
                senders: Some(vec!["a@b.c".into()]),
                ..Default::default()
            },
        };
        let label = Label {
            id: 5,
            name: "L".into(),
            color: "#fff".into(),
            keyword: "KwL".into(),
            position: 0,
            is_auto: false,
        };

        let c = unread_counts(&conn, Some(1), &[split], &[label]).unwrap();
        assert_eq!(c.splits["7"], 1);
        assert_eq!(c.labels["5"], 1);
    }
}
