//! Re-sorting existing mail after a split rule change.
//!
//! A rule edit only changes the verdict for threads that some rule matched
//! before or after the edit, so instead of re-resolving every thread we compare
//! the rule outcome under the old and new rule sets and touch only threads
//! whose outcome differs. That keeps an edit cheap on a large mailbox, leaves
//! AI and heuristic decisions on unaffected threads alone, and gives the UI an
//! exact "N threads will move" figure before anything is written.

use super::decide::PreviewThread;
use super::{Fallback, RuleSubject, apply_tab, decide, route_thread_deterministic};
use crate::error::{CoreError, Result};
use crate::models::{RouteKey, RuleCondition, SplitRule, SplitRuleQuery, roles};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

/// Threads re-routed per write transaction, so sync isn't blocked behind one
/// long transaction while a large inbox is re-sorted.
pub const CHUNK: usize = 400;

/// Every thread with a message in an inbox folder, newest first.
pub fn inbox_thread_ids(conn: &Connection) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT t.id FROM threads t
         WHERE EXISTS (SELECT 1 FROM messages m JOIN folders f ON f.id = m.folder_id
                       WHERE m.thread_id = t.id AND f.role = ?1)
         ORDER BY t.last_message_at DESC, t.id DESC",
    )?;
    let ids = stmt
        .query_map(params![roles::INBOX], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<i64>>>()?;
    Ok(ids)
}

/// What applying a rule change to existing inbox mail would do.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleChangeImpact {
    /// Inbox threads checked.
    pub scanned: usize,
    /// Threads whose rule outcome changes, i.e. that would change tab.
    pub moved: usize,
    /// Up to `limit` of the newest moving threads.
    pub samples: Vec<PreviewThread>,
}

fn verdicts_differ(
    conn: &Connection,
    before: &[SplitRule],
    after: &[SplitRule],
    thread_id: i64,
) -> Result<Option<super::Decision>> {
    let s = RuleSubject::load(conn, thread_id)?;
    let old = decide(&s, before);
    let new = decide(&s, after);
    Ok((old.route != new.route || old.needs_ai != new.needs_ai).then_some(new))
}

/// A rule edit the user hasn't committed yet, for [`impact`] previews.
/// Mirrors the arguments of the `save_split` / `delete_split` /
/// `reorder_tabs` commands.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RuleChange {
    Save {
        id: Option<i64>,
        name: String,
        position: i64,
        #[serde(default)]
        query: SplitRuleQuery,
        condition: Option<RuleCondition>,
        target: Option<RouteKey>,
        #[serde(default)]
        ai: Option<crate::models::AiCheck>,
    },
    Delete {
        id: i64,
    },
    /// `(kind, id)` top to bottom, as `reorder_tabs` takes it.
    Reorder {
        order: Vec<(String, i64)>,
    },
}

impl RuleChange {
    /// The position-ordered rule set after this change.
    pub fn apply_to(&self, before: &[SplitRule]) -> Vec<SplitRule> {
        let mut rules = before.to_vec();
        match self {
            RuleChange::Save {
                id,
                name,
                position,
                query,
                condition,
                target,
                ai,
            } => {
                // A new rule has no id yet; any id unused by real rows works.
                let id = id.unwrap_or(i64::MAX);
                rules.retain(|r| r.id != id);
                rules.push(SplitRule {
                    id,
                    name: name.clone(),
                    position: *position,
                    query: query.clone(),
                    condition: condition.clone(),
                    target: *target,
                    ai: ai.clone(),
                });
            }
            RuleChange::Delete { id } => {
                rules.retain(|r| r.id != *id);
                for r in &mut rules {
                    if r.target == Some(RouteKey::Split(*id)) {
                        r.target = None;
                    }
                }
            }
            RuleChange::Reorder { order } => {
                for (i, (kind, id)) in order.iter().enumerate() {
                    if kind == "split" {
                        if let Some(r) = rules.iter_mut().find(|r| r.id == *id) {
                            r.position = i as i64;
                        }
                    }
                }
            }
        }
        rules.sort_by_key(|r| (r.position, r.id));
        rules
    }
}

/// Dry run: which inbox threads change tab if `before` becomes `after`.
pub fn impact(
    conn: &Connection,
    before: &[SplitRule],
    after: &[SplitRule],
    limit: usize,
) -> Result<RuleChangeImpact> {
    let ids = inbox_thread_ids(conn)?;
    let mut out = RuleChangeImpact {
        scanned: ids.len(),
        ..Default::default()
    };
    for id in ids {
        if verdicts_differ(conn, before, after, id)?.is_none() {
            continue;
        }
        out.moved += 1;
        if out.samples.len() < limit {
            let row = conn
                .query_row(
                    "SELECT COALESCE(m.subject,''), COALESCE(m.from_addr,''), t.last_message_at
                     FROM threads t JOIN messages m ON m.thread_id = t.id
                     WHERE t.id = ?1 ORDER BY m.date DESC, m.id DESC LIMIT 1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            if let Some((subject, from_addr, last_message_at)) = row {
                out.samples.push(PreviewThread {
                    id,
                    subject,
                    from_addr,
                    last_message_at,
                });
            }
        }
    }
    Ok(out)
}

/// Re-route the threads in `ids` whose rule outcome differs between `before`
/// and `after`. A thread a rule now claims goes to that rule's tab; a thread no
/// rule claims any more falls back to `fallback`. Returns how many moved.
pub fn apply_diff(
    conn: &Connection,
    before: &[SplitRule],
    after: &[SplitRule],
    fallback: Fallback,
    ids: &[i64],
) -> Result<usize> {
    let mut moved = 0;
    for &id in ids {
        let Some(new) = verdicts_differ(conn, before, after, id)? else {
            continue;
        };
        match new.route {
            Some(key) => apply_tab(conn, id, Some(&key.to_string()))?,
            // An AI check now applies: the async pass routes it.
            None if new.needs_ai => apply_tab(conn, id, Some("pending"))?,
            None => route_thread_deterministic(conn, &[], fallback, id)?,
        }
        moved += 1;
    }
    Ok(moved)
}

/// Threads parked in a tab that no longer exists: a deleted split, a split
/// that now routes into another tab (so has none of its own), or a deleted
/// label. Such threads would otherwise vanish from every tab.
pub fn orphaned_thread_ids(conn: &Connection) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM threads
         WHERE (routed_tab LIKE 'split:%'
                AND routed_tab NOT IN (SELECT 'split:' || id FROM split_rules
                                       WHERE target IS NULL OR target = ''))
            OR (routed_tab LIKE 'label:%'
                AND routed_tab NOT IN (SELECT 'label:' || id FROM labels))",
    )?;
    let ids = stmt
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<i64>>>()?;
    Ok(ids)
}

/// Check a rule's destination against the current rows. A target must be a
/// tab that is actually shown: Important, Other, an existing label, or another
/// split that has its own tab. `self_id` is the rule being saved (`None` for a
/// new rule).
pub fn validate_target(
    conn: &Connection,
    self_id: Option<i64>,
    target: Option<RouteKey>,
) -> Result<()> {
    let bad = |msg: String| Err(CoreError::Other(format!("invalid split target: {msg}")));
    match target {
        None | Some(RouteKey::Important | RouteKey::Other) => {}
        Some(RouteKey::Pending) => return bad("'pending' is not a tab".into()),
        Some(RouteKey::Split(id)) => {
            if Some(id) == self_id {
                return bad("a split can't route into itself".into());
            }
            let other: Option<Option<String>> = conn
                .query_row(
                    "SELECT target FROM split_rules WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()?;
            match other {
                None => return bad(format!("split {id} doesn't exist")),
                Some(Some(t)) if !t.is_empty() => {
                    return bad(format!("split {id} has no tab of its own"));
                }
                Some(_) => {}
            }
        }
        Some(RouteKey::Label(id)) => {
            let exists: bool = conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM labels WHERE id = ?1)",
                params![id],
                |r| r.get(0),
            )?;
            if !exists {
                return bad(format!("label {id} doesn't exist"));
            }
        }
    }
    // Giving a rule a target removes its own tab; other rules routing into
    // that tab would then point at nothing.
    if let (Some(id), Some(_)) = (self_id, target) {
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM split_rules WHERE target = ?1 AND id <> ?2",
            params![format!("split:{id}"), id],
            |r| r.get(0),
        )?;
        if n > 0 {
            return bad(format!("{n} other split(s) route into this tab"));
        }
    }
    Ok(())
}

/// Rules that routed into split `id` become their own tab when it's deleted.
pub fn detach_targets_to(conn: &Connection, split_id: i64) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE split_rules SET target = NULL WHERE target = ?1",
        params![format!("split:{split_id}")],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testutil;
    use crate::models::{RuleCondition, SplitRuleQuery, TextOp};

    fn rule(id: i64, sender: &str, target: Option<RouteKey>) -> SplitRule {
        SplitRule {
            id,
            name: format!("r{id}"),
            position: id,
            query: SplitRuleQuery::default(),
            condition: Some(RuleCondition::Sender {
                op: TextOp::Contains,
                value: sender.into(),
            }),
            target,
            ai: None,
        }
    }

    fn routed(c: &Connection, t: i64) -> Option<String> {
        c.query_row(
            "SELECT routed_tab FROM threads WHERE id = ?1",
            params![t],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn insert_rule(c: &Connection, id: i64, target: Option<&str>) {
        c.execute(
            "INSERT INTO split_rules (id, name, position, query_json, target)
             VALUES (?1, 'r', ?1, '{}', ?2)",
            params![id, target],
        )
        .unwrap();
    }

    #[test]
    fn impact_counts_only_changed_verdicts() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let gh = testutil::seed_message(&c, "noreply@github.com", "CI", true).0;
        let _bob = testutil::seed_message(&c, "bob@acme.io", "Lunch", false).0;
        let before = vec![rule(1, "github", None)];
        // Unchanged rules: nothing moves.
        let i = impact(&c, &before, &before, 5).unwrap();
        assert_eq!((i.scanned, i.moved), (2, 0));
        // Retargeting the rule moves only the GitHub thread.
        let after = vec![rule(1, "github", Some(RouteKey::Other))];
        let i = impact(&c, &before, &after, 5).unwrap();
        assert_eq!(i.moved, 1);
        assert_eq!(i.samples[0].id, gh);
    }

    #[test]
    fn apply_diff_leaves_unaffected_threads_alone() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let gh = testutil::seed_message(&c, "noreply@github.com", "CI", true).0;
        let bob = testutil::seed_message(&c, "bob@acme.io", "Lunch", false).0;
        // Pretend the AI already put Bob somewhere; a rule edit mustn't undo it.
        c.execute(
            "UPDATE threads SET routed_tab = 'important' WHERE id = ?1",
            params![bob],
        )
        .unwrap();
        c.execute(
            "UPDATE threads SET routed_tab = 'split:1' WHERE id = ?1",
            params![gh],
        )
        .unwrap();
        let before = vec![rule(1, "github", None)];
        let ids = inbox_thread_ids(&c).unwrap();

        // Deleting the rule: GitHub falls back, Bob is untouched.
        let n = apply_diff(&c, &before, &[], Fallback::Off, &ids).unwrap();
        assert_eq!(n, 1);
        assert_eq!(routed(&c, gh), None);
        assert_eq!(routed(&c, bob).as_deref(), Some("important"));

        // Adding it back routes GitHub again.
        let n = apply_diff(&c, &[], &before, Fallback::Off, &ids).unwrap();
        assert_eq!(n, 1);
        assert_eq!(routed(&c, gh).as_deref(), Some("split:1"));
    }

    #[test]
    fn orphans_cover_deleted_and_targeted_splits_and_labels() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        insert_rule(&c, 1, None);
        insert_rule(&c, 2, Some("other"));
        let keep = testutil::seed_message(&c, "a@x.io", "a", false).0;
        let gone = testutil::seed_message(&c, "b@x.io", "b", false).0;
        let targeted = testutil::seed_message(&c, "c@x.io", "c", false).0;
        let no_label = testutil::seed_message(&c, "d@x.io", "d", false).0;
        for (t, k) in [
            (keep, "split:1"),
            (gone, "split:9"),
            (targeted, "split:2"),
            (no_label, "label:999"),
        ] {
            c.execute(
                "UPDATE threads SET routed_tab = ?2 WHERE id = ?1",
                params![t, k],
            )
            .unwrap();
        }
        let mut o = orphaned_thread_ids(&c).unwrap();
        o.sort();
        assert_eq!(o, vec![gone, targeted, no_label]);
    }

    #[test]
    fn rule_change_builds_the_new_order() {
        let before = vec![rule(1, "a", None), rule(2, "b", Some(RouteKey::Split(1)))];
        let ids = |v: Vec<SplitRule>| v.iter().map(|r| r.id).collect::<Vec<_>>();
        let swapped = RuleChange::Reorder {
            order: vec![
                ("split".into(), 2),
                ("label".into(), 7),
                ("split".into(), 1),
            ],
        }
        .apply_to(&before);
        assert_eq!(ids(swapped), vec![2, 1]);
        let deleted = RuleChange::Delete { id: 1 }.apply_to(&before);
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].target, None, "detached from the deleted tab");
        let json = r#"{"kind":"save","id":null,"name":"n","position":1,
                       "condition":{"kind":"label","id":3},"target":null}"#;
        let added = serde_json::from_str::<RuleChange>(json)
            .unwrap()
            .apply_to(&before);
        assert_eq!(ids(added), vec![1, i64::MAX, 2]);
    }

    #[test]
    fn rules_apply_with_auto_labels_off() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let gh = testutil::seed_message(&c, "noreply@github.com", "CI", true).0;
        let shop = testutil::seed_message(&c, "offers@shop.example", "50% off", true).0;
        let rules = vec![rule(1, "github", None)];
        route_thread_deterministic(&c, &rules, Fallback::Off, gh).unwrap();
        route_thread_deterministic(&c, &rules, Fallback::Off, shop).unwrap();
        assert_eq!(routed(&c, gh).as_deref(), Some("split:1"));
        assert_eq!(routed(&c, shop), None, "no auto category when off");
    }

    #[test]
    fn stale_ai_verdict_never_overwrites_newer_routing() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let t = testutil::seed_message(&c, "a@x.io", "hi", false).0;
        c.execute(
            "UPDATE threads SET routed_tab = 'pending' WHERE id = ?1",
            params![t],
        )
        .unwrap();
        assert!(super::super::apply_ai_tab(&c, t, Some("other")).unwrap());
        assert_eq!(routed(&c, t).as_deref(), Some("other"));
        // A rule routed it meanwhile: the late AI answer is dropped.
        c.execute(
            "UPDATE threads SET routed_tab = 'split:4' WHERE id = ?1",
            params![t],
        )
        .unwrap();
        assert!(!super::super::apply_ai_tab(&c, t, Some("important")).unwrap());
        assert_eq!(routed(&c, t).as_deref(), Some("split:4"));
    }

    #[test]
    fn manual_labels_move_threads_in_and_out_of_label_splits() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        let label = crate::db::repo::labels::save(&c, None, "Invoices", "#888", 0)
            .unwrap()
            .id;
        let (t, msg) = testutil::seed_message(&c, "billing@acme.io", "March", false);
        let mut r = rule(1, "", None);
        r.condition = Some(RuleCondition::Label { id: label });
        let rules = vec![r];
        crate::db::repo::labels::add_to_message(&c, msg, label).unwrap();
        super::super::reroute_after_label_change(&c, &rules, Fallback::Off, t).unwrap();
        assert_eq!(routed(&c, t).as_deref(), Some("split:1"));
        c.execute(
            "DELETE FROM message_labels WHERE message_id = ?1",
            params![msg],
        )
        .unwrap();
        super::super::reroute_after_label_change(&c, &rules, Fallback::Off, t).unwrap();
        assert_eq!(routed(&c, t), None);
    }

    #[test]
    fn target_validation() {
        let c = testutil::conn();
        testutil::seed_account(&c);
        insert_rule(&c, 1, None);
        insert_rule(&c, 2, Some("other"));
        insert_rule(&c, 3, Some("split:1"));
        let ok = |id, t| validate_target(&c, id, t).is_ok();
        assert!(ok(None, None));
        assert!(ok(None, Some(RouteKey::Important)));
        assert!(ok(None, Some(RouteKey::Split(1))));
        assert!(!ok(None, Some(RouteKey::Pending)));
        assert!(!ok(Some(1), Some(RouteKey::Split(1))), "self");
        assert!(!ok(None, Some(RouteKey::Split(2))), "split without a tab");
        assert!(!ok(None, Some(RouteKey::Split(42))), "missing split");
        assert!(!ok(None, Some(RouteKey::Label(999))), "missing label");
        // Rule 3 routes into split 1, so split 1 can't give up its tab.
        assert!(!ok(Some(1), Some(RouteKey::Other)));
        assert_eq!(detach_targets_to(&c, 1).unwrap(), 1);
        assert!(ok(Some(1), Some(RouteKey::Other)));
    }
}
