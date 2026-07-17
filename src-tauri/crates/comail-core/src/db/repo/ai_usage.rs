use crate::error::Result;
use crate::models::{AiUsageDay, AiUsageStats};
use rusqlite::{Connection, params};

pub fn record(
    conn: &Connection,
    occurred_at: i64,
    model: &str,
    scenario: &str,
    prompt_tokens: i64,
    completion_tokens: i64,
    total_tokens: i64,
    exact: bool,
) -> Result<()> {
    conn.execute(
        "INSERT INTO ai_usage_events
         (occurred_at, model, scenario, prompt_tokens, completion_tokens, total_tokens, exact)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            occurred_at,
            model,
            scenario,
            prompt_tokens.max(0),
            completion_tokens.max(0),
            total_tokens.max(0),
            exact as i64,
        ],
    )?;
    Ok(())
}

pub fn stats(conn: &Connection) -> Result<AiUsageStats> {
    let totals = conn.query_row(
        "SELECT
           COALESCE(SUM(total_tokens), 0),
           COUNT(*),
           COALESCE(SUM(CASE WHEN date(occurred_at / 1000, 'unixepoch', 'localtime') = date('now', 'localtime') THEN total_tokens ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN date(occurred_at / 1000, 'unixepoch', 'localtime') = date('now', 'localtime', '-1 day') THEN total_tokens ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN date(occurred_at / 1000, 'unixepoch', 'localtime') >= date('now', 'localtime', '-6 days') THEN total_tokens ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN date(occurred_at / 1000, 'unixepoch', 'localtime') >= date('now', 'localtime', '-29 days') THEN total_tokens ELSE 0 END), 0)
         FROM ai_usage_events",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        },
    )?;

    let mut stmt = conn.prepare(
        "SELECT date(occurred_at / 1000, 'unixepoch', 'localtime') AS day,
                SUM(total_tokens), COUNT(*)
         FROM ai_usage_events
         WHERE date(occurred_at / 1000, 'unixepoch', 'localtime') >= date('now', 'localtime', '-90 days')
         GROUP BY day ORDER BY day",
    )?;
    let days = stmt
        .query_map([], |row| {
            Ok(AiUsageDay {
                date: row.get(0)?,
                total_tokens: row.get(1)?,
                requests: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(AiUsageStats {
        total_tokens: totals.0,
        total_requests: totals.1,
        today_tokens: totals.2,
        yesterday_tokens: totals.3,
        last_7_days_tokens: totals.4,
        last_30_days_tokens: totals.5,
        days,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testutil;

    #[test]
    fn records_and_aggregates_usage() {
        let c = testutil::conn();
        let now = chrono::Utc::now().timestamp_millis();
        record(&c, now, "model-a", "draft", 70, 30, 100, true).unwrap();
        record(&c, now - 86_400_000, "model-a", "ask", 150, 50, 200, false).unwrap();
        let out = stats(&c).unwrap();
        assert_eq!(out.total_tokens, 300);
        assert_eq!(out.total_requests, 2);
        assert_eq!(out.today_tokens, 100);
        assert_eq!(out.yesterday_tokens, 200);
        assert_eq!(out.last_7_days_tokens, 300);
        assert_eq!(out.days.iter().map(|d| d.requests).sum::<i64>(), 2);
    }
}
