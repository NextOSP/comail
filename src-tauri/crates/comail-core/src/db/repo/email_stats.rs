use crate::error::Result;
use crate::models::{EmailActivityDay, EmailStats};
use rusqlite::Connection;

/// Aggregate real sent/received message history. Drafts are deliberately
/// excluded; `is_outgoing` is the canonical direction flag across providers.
pub fn stats(conn: &Connection) -> Result<EmailStats> {
    let totals = conn.query_row(
        "SELECT
           COALESCE(SUM(CASE WHEN is_outgoing = 1 THEN 1 ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN is_outgoing = 0 THEN 1 ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN is_outgoing = 1 AND date(date / 1000, 'unixepoch', 'localtime') = date('now', 'localtime') THEN 1 ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN is_outgoing = 0 AND date(date / 1000, 'unixepoch', 'localtime') = date('now', 'localtime') THEN 1 ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN is_outgoing = 1 AND date(date / 1000, 'unixepoch', 'localtime') >= date('now', 'localtime', '-6 days') THEN 1 ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN is_outgoing = 0 AND date(date / 1000, 'unixepoch', 'localtime') >= date('now', 'localtime', '-6 days') THEN 1 ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN is_outgoing = 1 AND date(date / 1000, 'unixepoch', 'localtime') >= date('now', 'localtime', '-29 days') THEN 1 ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN is_outgoing = 0 AND date(date / 1000, 'unixepoch', 'localtime') >= date('now', 'localtime', '-29 days') THEN 1 ELSE 0 END), 0)
         FROM messages
         WHERE is_draft = 0",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        },
    )?;

    let mut stmt = conn.prepare(
        "SELECT date(date / 1000, 'unixepoch', 'localtime') AS day,
                SUM(CASE WHEN is_outgoing = 1 THEN 1 ELSE 0 END),
                SUM(CASE WHEN is_outgoing = 0 THEN 1 ELSE 0 END)
         FROM messages
         WHERE is_draft = 0
           AND date(date / 1000, 'unixepoch', 'localtime') >= date('now', 'localtime', '-364 days')
         GROUP BY day ORDER BY day",
    )?;
    let days = stmt
        .query_map([], |row| {
            Ok(EmailActivityDay {
                date: row.get(0)?,
                sent: row.get(1)?,
                received: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(EmailStats {
        total_sent: totals.0,
        total_received: totals.1,
        today_sent: totals.2,
        today_received: totals.3,
        last_7_days_sent: totals.4,
        last_7_days_received: totals.5,
        last_30_days_sent: totals.6,
        last_30_days_received: totals.7,
        days,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testutil;
    use rusqlite::params;

    #[test]
    fn counts_sent_and_received_but_not_drafts() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let now = chrono::Utc::now().timestamp_millis();
        let yesterday = now - 86_400_000;
        for (date, outgoing, draft) in [(now, 1, 0), (now, 0, 0), (yesterday, 0, 0), (now, 1, 1)] {
            c.execute(
                "INSERT INTO messages (account_id, subject, date, is_outgoing, is_draft)
                 VALUES (1, 'Stats', ?1, ?2, ?3)",
                params![date, outgoing, draft],
            )
            .unwrap();
        }

        let out = stats(&c).unwrap();
        assert_eq!(out.total_sent, 1);
        assert_eq!(out.total_received, 2);
        assert_eq!(out.today_sent, 1);
        assert_eq!(out.today_received, 1);
        assert_eq!(out.last_7_days_sent, 1);
        assert_eq!(out.last_7_days_received, 2);
        assert_eq!(out.days.iter().map(|day| day.sent).sum::<i64>(), 1);
        assert_eq!(out.days.iter().map(|day| day.received).sum::<i64>(), 2);
    }
}
