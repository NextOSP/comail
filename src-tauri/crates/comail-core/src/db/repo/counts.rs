//! Exact inbox tab and sidebar badge counts.

use crate::error::Result;
use crate::models::{Label, SplitRule, TabTotals, UnreadCounts};
use rusqlite::{Connection, params};
use std::collections::HashMap;

/// Composable COUNT(*) query over threads (+ snoozes join, like SUMMARY_SELECT).
struct Q {
    clauses: Vec<String>,
    bind: Vec<Box<dyn rusqlite::types::ToSql>>,
    unread_only: bool,
}

impl Q {
    /// Base: threads with unread messages, optionally account-scoped.
    fn unread(account_id: Option<i64>) -> Self {
        let mut q = Q {
            clauses: Vec::new(),
            bind: Vec::new(),
            unread_only: true,
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
            unread_only: false,
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

    fn run(mut self, conn: &Connection) -> Result<i64> {
        if self.unread_only {
            self.clauses.push("t.id IN (SELECT m.thread_id FROM visible_messages m LEFT JOIN folders f ON f.id=m.folder_id WHERE m.is_read=0 AND COALESCE(f.role,'') NOT IN ('trash','spam'))".into());
        }
        let where_sql = if self.clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", self.clauses.join(" AND "))
        };
        let sql = format!(
            "SELECT COUNT(*) FROM threads t LEFT JOIN snoozes s ON s.thread_id = t.id {where_sql}"
        );
        let params: Vec<&dyn rusqlite::types::ToSql> =
            self.bind.iter().map(|b| b.as_ref()).collect();
        Ok(conn.query_row(&sql, params.as_slice(), |r| r.get(0))?)
    }
}

// SQLite can scan every message for each inbox folder. Use the folder index
// for membership and let visible_messages exclude pending deletes by row ID.
const INBOX_COUNTS_SQL: &str = r#"
    WITH inbox AS MATERIALIZED (
        SELECT t.id, t.routed_tab, MAX(m.is_read = 0) AS unread
        FROM folders f
        CROSS JOIN messages member INDEXED BY idx_messages_folder_uid ON member.folder_id = f.id
        CROSS JOIN visible_messages m ON m.id = member.id
        CROSS JOIN threads t ON t.id = m.thread_id
        LEFT JOIN snoozes s ON s.thread_id = t.id
        WHERE f.role = 'inbox' AND s.thread_id IS NULL
          AND (?1 IS NULL OR t.account_id = ?1)
          AND (?3 OR m.is_read = 0)
        GROUP BY t.id
    ),
    routed AS (
        SELECT unread,
               CASE WHEN routed_tab IS NOT NULL AND routed_tab <> 'pending' THEN routed_tab
                    ELSE CASE (
                        SELECT m.is_automated FROM visible_messages m
                        WHERE m.thread_id = i.id AND m.is_draft = 0 AND m.is_outgoing = 0
                        ORDER BY m.date DESC, m.id DESC LIMIT 1
                    )
                    WHEN 0 THEN 'important' WHEN 1 THEN 'other'
                    END
               END AS route
        FROM inbox i
    ),
    manual AS (
        SELECT DISTINCT i.id, ml.label_id, i.unread
        FROM inbox i
        CROSS JOIN visible_messages m ON m.thread_id = i.id
        JOIN message_labels ml ON ml.message_id = m.id
        WHERE ?2
    )
    SELECT NULL, route, COUNT(*), SUM(unread) FROM routed GROUP BY route
    UNION ALL
    SELECT label_id, NULL, COUNT(*), SUM(unread) FROM manual GROUP BY label_id
"#;

#[derive(Clone, Copy, Default)]
struct Count {
    total: i64,
    unread: i64,
}

#[derive(Default)]
struct InboxCounts {
    inbox: Count,
    routes: HashMap<String, Count>,
    manual: HashMap<i64, Count>,
}

impl InboxCounts {
    fn load(
        conn: &Connection,
        account_id: Option<i64>,
        labels: &[Label],
        include_read: bool,
    ) -> Result<Self> {
        let has_manual_labels = labels.iter().any(|label| !label.is_auto);
        let mut stmt = conn.prepare_cached(INBOX_COUNTS_SQL)?;
        let mut rows = stmt.query(params![account_id, has_manual_labels, include_read])?;
        let mut counts = Self::default();
        while let Some(row) = rows.next()? {
            let manual_label_id: Option<i64> = row.get(0)?;
            let count = Count {
                total: row.get(2)?,
                unread: row.get(3)?,
            };
            if let Some(id) = manual_label_id {
                counts.manual.insert(id, count);
            } else {
                counts.inbox.total += count.total;
                counts.inbox.unread += count.unread;
                if let Some(route) = row.get(1)? {
                    counts.routes.insert(route, count);
                }
            }
        }
        Ok(counts)
    }

    fn route(&self, route: &str) -> Count {
        self.routes.get(route).copied().unwrap_or_default()
    }

    fn label(&self, label: &Label) -> Count {
        if label.is_auto {
            self.route(&format!("label:{}", label.id))
        } else {
            self.manual.get(&label.id).copied().unwrap_or_default()
        }
    }
}

pub fn unread_counts(
    conn: &Connection,
    account_id: Option<i64>,
    splits: &[SplitRule],
    labels: &[Label],
) -> Result<UnreadCounts> {
    let include_read = splits.iter().any(|split| split.count_all);
    let counts = InboxCounts::load(conn, account_id, labels, include_read)?;
    let splits = splits
        .iter()
        .map(|sp| {
            let count = counts.route(&format!("split:{}", sp.id));
            let badge = if sp.count_all {
                count.total
            } else {
                count.unread
            };
            (sp.id.to_string(), badge)
        })
        .collect();
    let labels = labels
        .iter()
        .map(|label| (label.id.to_string(), counts.label(label).unread))
        .collect();

    let mut views = HashMap::new();
    views.insert(
        "starred".to_string(),
        Q::unread(account_id)
            .clause(super::threads::HAS_VISIBLE_STAR)
            .clause(super::threads::HAS_VISIBLE_MAIL)
            .run(conn)?,
    );
    views.insert(
        "snoozed".to_string(),
        Q::unread(account_id)
            .clause("s.thread_id IS NOT NULL")
            .clause(super::threads::HAS_VISIBLE_MAIL)
            .run(conn)?,
    );
    // Spam is never notified, so its badge is the only signal that mail landed there.
    views.insert("spam".to_string(), Q::any(account_id).clause(
        "t.id IN (SELECT m.thread_id FROM visible_messages m JOIN folders f ON f.id=m.folder_id WHERE m.is_read=0 AND f.role='spam')"
    ).run(conn)?);
    // Drafts badge = number of threads with a draft, unread or not.
    views.insert(
        "drafts".to_string(),
        Q::any(account_id)
            .clause(
                "t.id IN (SELECT m.thread_id FROM visible_messages m JOIN folders f ON f.id = m.folder_id
                          WHERE m.is_draft = 1 AND f.role = 'drafts')",
            )
            .run(conn)?,
    );

    Ok(UnreadCounts {
        inbox: counts.inbox.unread,
        important: counts.route("important").unread,
        other: counts.route("other").unread,
        splits,
        labels,
        views,
    })
}

/// How many conversations each inbox tab, and the inbox as a whole, holds,
/// read or not. Same tab membership as the badges in `unread_counts`, minus
/// the unread filter; queried while the "all" tab-count setting is on, and
/// for the "Run automations" confirmation.
pub fn tab_totals(
    conn: &Connection,
    account_id: Option<i64>,
    splits: &[SplitRule],
    labels: &[Label],
) -> Result<TabTotals> {
    let counts = InboxCounts::load(conn, account_id, labels, true)?;
    Ok(TabTotals {
        inbox: counts.inbox.total,
        important: counts.route("important").total,
        other: counts.route("other").total,
        splits: splits
            .iter()
            .map(|sp| {
                let count = counts.route(&format!("split:{}", sp.id));
                (sp.id.to_string(), count.total)
            })
            .collect(),
        labels: labels
            .iter()
            .map(|label| (label.id.to_string(), counts.label(label).total))
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SplitRuleQuery;
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

    fn append_incoming(conn: &Connection, thread_id: i64, date: i64, automated: bool) {
        conn.execute(
            "INSERT INTO messages (thread_id, account_id, folder_id, subject,
             from_addr, date, is_read, is_automated, is_draft, is_outgoing)
             VALUES (?1, 1, 1, 'follow-up', 'reply@b.c', ?2, 0, ?3, 0, 0)",
            params![thread_id, date, automated as i64],
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
        assert_eq!(c.views["spam"], 0);

        // account filter that matches nothing
        let none = unread_counts(&conn, Some(99), &[], &[]).unwrap();
        assert_eq!(none.inbox, 0);
    }

    #[test]
    fn mixed_threads_are_counted_by_the_newest_incoming_message() {
        let conn = test_db();
        seed_thread(&conn, 1, 1, false);
        append_incoming(&conn, 1, 2000, true);
        seed_thread(&conn, 2, 1, true);
        append_incoming(&conn, 2, 2000, false);

        let c = unread_counts(&conn, None, &[], &[]).unwrap();
        assert_eq!(c.inbox, 2);
        assert_eq!(c.important, 1, "latest human reply belongs in Important");
        assert_eq!(c.other, 1, "latest automated reply belongs in Other");
    }

    #[test]
    fn mixed_thread_badges_only_count_unread_in_their_scope() {
        let conn = test_db();
        conn.execute_batch("INSERT INTO folders(id,account_id,imap_name,role) VALUES (2,1,'Trash','trash'),(3,1,'Spam','spam');").unwrap();
        seed_thread(&conn, 1, 1, false);
        conn.execute("UPDATE messages SET folder_id=2 WHERE thread_id=1", [])
            .unwrap();
        append_incoming(&conn, 1, 2000, false);
        conn.execute(
            "UPDATE messages SET is_read=1,is_starred=1 WHERE folder_id=1",
            [],
        )
        .unwrap();
        let c = unread_counts(&conn, None, &[], &[]).unwrap();
        assert_eq!(c.inbox, 0, "unread trash must not badge read inbox mail");
        assert_eq!(c.views["starred"], 0);
        conn.execute("UPDATE messages SET folder_id=3 WHERE folder_id=2", [])
            .unwrap();
        let c = unread_counts(&conn, None, &[], &[]).unwrap();
        assert_eq!(c.views["spam"], 1);
        assert_eq!(c.inbox, 0);
        conn.execute(
            "UPDATE messages SET is_read=CASE WHEN folder_id=3 THEN 1 ELSE 0 END",
            [],
        )
        .unwrap();
        let c = unread_counts(&conn, None, &[], &[]).unwrap();
        assert_eq!(c.views["spam"], 0, "unread inbox must not badge read spam");
        assert_eq!(c.inbox, 1);
        assert_eq!(c.views["starred"], 1);
    }

    #[test]
    fn counts_unread_spam() {
        let conn = test_db();
        conn.execute(
            "INSERT INTO folders (id, account_id, imap_name, role) VALUES (2,1,'Spam','spam')",
            [],
        )
        .unwrap();
        seed_thread(&conn, 1, 1, false);
        seed_thread(&conn, 2, 1, false);
        seed_thread(&conn, 3, 0, false);
        conn.execute(
            "UPDATE messages SET folder_id = 2 WHERE thread_id IN (2, 3)",
            [],
        )
        .unwrap();

        let c = unread_counts(&conn, None, &[], &[]).unwrap();
        assert_eq!(c.views["spam"], 1);
        assert_eq!(c.inbox, 1);
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
            .query_row("SELECT id FROM messages WHERE thread_id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        conn.execute(
            "INSERT INTO message_labels (message_id, label_id) VALUES (?1, 5)",
            params![msg_id],
        )
        .unwrap();
        // The custom-split count now reads the resolved tab, so route thread 1
        // into split:7 (the resolver does this at sync time).
        conn.execute("UPDATE threads SET routed_tab = 'split:7' WHERE id = 1", [])
            .unwrap();

        let split = SplitRule {
            id: 7,
            name: "s".into(),
            position: 0,
            query: SplitRuleQuery {
                senders: Some(vec!["a@b.c".into()]),
                ..Default::default()
            },
            condition: None,
            target: None,
            ai: None,
            count_all: false,
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

    #[test]
    fn count_all_split_badges_read_conversations_too() {
        let conn = test_db();
        seed_thread(&conn, 1, 1, false); // unread
        seed_thread(&conn, 2, 0, false); // read
        conn.execute(
            "UPDATE threads SET routed_tab = 'split:7' WHERE id IN (1, 2)",
            [],
        )
        .unwrap();

        let mut split = SplitRule {
            id: 7,
            name: "s".into(),
            position: 0,
            query: SplitRuleQuery::default(),
            condition: None,
            target: None,
            ai: None,
            count_all: false,
        };

        let unread_only = unread_counts(&conn, None, std::slice::from_ref(&split), &[]).unwrap();
        assert_eq!(unread_only.splits["7"], 1, "default stays unread-only");

        split.count_all = true;
        let all = unread_counts(&conn, None, std::slice::from_ref(&split), &[]).unwrap();
        assert_eq!(all.splits["7"], 2, "count_all includes the read thread");

        // The opt-in is per split: the shared inbox/Important/Other badges are
        // untouched by it.
        assert_eq!(all.inbox, unread_only.inbox);
        assert_eq!(all.important, unread_only.important);
    }

    #[test]
    fn tab_totals_count_read_and_unread_per_tab() {
        let conn = test_db();
        seed_thread(&conn, 1, 1, false); // unread human -> Important
        seed_thread(&conn, 2, 0, false); // read human -> Important
        seed_thread(&conn, 3, 0, true); // read automated -> Other
        seed_thread(&conn, 4, 0, false); // read, routed to split 7
        seed_thread(&conn, 5, 1, true); // unread, routed to auto label 9
        conn.execute("UPDATE threads SET routed_tab = 'split:7' WHERE id = 4", [])
            .unwrap();
        conn.execute("UPDATE threads SET routed_tab = 'label:9' WHERE id = 5", [])
            .unwrap();
        // Snoozed mail is out of the inbox, so no tab holds it.
        seed_thread(&conn, 6, 0, false);
        conn.execute(
            "INSERT INTO snoozes (thread_id, account_id, wake_at) VALUES (6, 1, 9999999999999)",
            [],
        )
        .unwrap();

        let split = SplitRule {
            id: 7,
            name: "s".into(),
            position: 0,
            query: SplitRuleQuery::default(),
            condition: None,
            target: None,
            ai: None,
            count_all: false,
        };
        let label = Label {
            id: 9,
            name: "News".into(),
            color: "#fff".into(),
            keyword: "KwNews".into(),
            position: 0,
            is_auto: true,
        };

        let t = tab_totals(&conn, None, &[split.clone()], &[label.clone()]).unwrap();
        assert_eq!(t.inbox, 5, "every tab's conversations, not the snoozed one");
        assert_eq!(t.important, 2, "read and unread Important mail");
        assert_eq!(t.other, 1);
        assert_eq!(t.splits["7"], 1);
        assert_eq!(t.labels["9"], 1);

        let none = tab_totals(&conn, Some(99), &[split], &[label]).unwrap();
        assert_eq!(none.inbox, 0);
        assert_eq!(none.important, 0);
        assert_eq!(none.splits["7"], 0);
    }
    #[test]
    fn grouped_counts_keep_inbox_visibility_and_manual_label_membership() {
        let conn = test_db();
        seed_thread(&conn, 1, 1, false);
        seed_thread(&conn, 2, 0, true);
        seed_thread(&conn, 3, 1, false);
        seed_thread(&conn, 4, 1, false);
        seed_thread(&conn, 5, 1, false);
        conn.execute_batch(
            "INSERT INTO accounts (id, email, provider, auth_kind, username,
                   imap_host, imap_port, smtp_host, smtp_port, created_at)
             VALUES (2,'second@x.com','imap','password','t','h',993,'h',587,0);
             INSERT INTO folders (id, account_id, imap_name, role)
             VALUES (2,1,'Archive','archive'), (3,2,'INBOX','inbox');
             INSERT INTO threads (id, account_id, routed_tab) VALUES (6,2,'label:9');
             INSERT INTO messages (id, account_id, thread_id, folder_id, date)
             VALUES (6,2,6,3,1000);

             UPDATE threads SET routed_tab = 'pending' WHERE id = 1;
             UPDATE threads SET routed_tab = 'important' WHERE id = 2;
             UPDATE messages SET is_starred = 1 WHERE thread_id = 2;
             UPDATE messages SET is_outgoing = 1 WHERE thread_id = 3;
             INSERT INTO snoozes (thread_id, account_id, wake_at) VALUES (5,1,9999999999999);

             INSERT INTO messages (id, account_id, thread_id, folder_id, date, is_automated, is_outgoing)
             VALUES (20,1,1,2,1000,1,0), (21,1,1,2,2000,0,0), (22,1,1,2,3000,0,1),
                    (23,1,2,2,2000,0,0), (24,1,4,2,2000,0,0);
             INSERT INTO pending_actions (account_id, kind, message_id, state, created_at)
             VALUES (1,'delete_permanently',4,'pending',0),
                    (1,'delete_permanently',21,'inflight',0);

             INSERT INTO labels (id, name, keyword, is_auto)
             VALUES (5,'Shared','Shared',0), (7,'Archive-only','Archived',0),
                    (8,'Hidden','Hidden',0), (9,'Auto','Auto',1);
             INSERT INTO message_labels (message_id, label_id)
             VALUES (1,5), (20,5), (20,7), (21,8), (23,5), (24,5), (5,5), (6,5);",
        )
        .unwrap();

        let labels = [5, 7, 8, 9].map(|id| Label {
            id,
            name: String::new(),
            color: String::new(),
            keyword: String::new(),
            position: 0,
            is_auto: id == 9,
        });
        let unread = unread_counts(&conn, Some(1), &[], &labels).unwrap();
        let totals = tab_totals(&conn, Some(1), &[], &labels).unwrap();

        assert_eq!((unread.inbox, unread.important, unread.other), (2, 0, 1));
        assert_eq!((totals.inbox, totals.important, totals.other), (3, 1, 1));
        assert_eq!(unread.views["starred"], 1);
        assert_eq!(unread.views["snoozed"], 1);
        assert_eq!(
            unread.labels,
            HashMap::from([
                ("5".into(), 1),
                ("7".into(), 1),
                ("8".into(), 0),
                ("9".into(), 0)
            ])
        );
        assert_eq!(
            totals.labels,
            HashMap::from([
                ("5".into(), 2),
                ("7".into(), 1),
                ("8".into(), 0),
                ("9".into(), 0)
            ])
        );

        let all = unread_counts(&conn, None, &[], &labels).unwrap();
        assert_eq!(all.inbox, 3);
        assert_eq!(all.labels["5"], 2);
        assert_eq!(all.labels["9"], 1);
    }
}
