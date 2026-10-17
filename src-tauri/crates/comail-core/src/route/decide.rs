//! The rule decision API: load a thread's facts once ([`RuleSubject`]), then
//! evaluate typed [`RuleCondition`] trees against them in memory. [`decide`]
//! is the fast path used by routing; [`explain`] also records which leaf
//! conditions passed so the UI can show why a thread landed where it did.

use crate::error::Result;
use crate::models::{RouteKey, RuleCondition, SplitRule, TextOp};
use crate::search::fold;
use rusqlite::{Connection, params};
use serde::Serialize;
use std::collections::HashSet;

/// Everything a split rule condition can test about one thread.
#[derive(Debug, Clone, Default)]
pub struct RuleSubject {
    /// Normalized ([`crate::addr::normalize`]) From address of every inbound
    /// message. The user's own replies don't count: a rule for
    /// `@mycompany.com` must not claim every thread the user answered.
    pub senders: Vec<String>,
    /// Lowercased raw To/Cc JSON per message; `contains` matches here so it
    /// also sees display names, like the legacy SQL `LIKE`.
    pub recipients_raw: Vec<String>,
    /// Normalized To/Cc addresses, for every operator.
    pub recipient_addrs: Vec<String>,
    /// Folded subject (with any local AI prefix) of every inbound message.
    pub subjects: Vec<String>,
    /// The same subjects, only lowercased, for needles in scripts that
    /// folding would transliterate (see [`fold_subject_needle`]).
    pub subjects_raw: Vec<String>,
    pub label_ids: HashSet<i64>,
    /// `None` when the thread has no inbound message.
    pub latest_is_automated: Option<bool>,
    pub has_attachment: bool,
}

impl RuleSubject {
    pub fn load(conn: &Connection, thread_id: i64) -> Result<Self> {
        let mut s = RuleSubject::default();
        let mut stmt = conn.prepare_cached(
            "SELECT COALESCE(from_addr,''), COALESCE(to_json,'[]'),
                    COALESCE(cc_json,'[]'),
                    COALESCE(local_subject_prefix,'') || COALESCE(subject,''),
                    is_draft, is_outgoing, is_automated, has_attachments
             FROM messages WHERE thread_id = ?1
             ORDER BY date DESC, id DESC",
        )?;
        let mut rows = stmt.query(params![thread_id])?;
        while let Some(r) = rows.next()? {
            let from: String = r.get(0)?;
            let to: String = r.get(1)?;
            let cc: String = r.get(2)?;
            let subject: String = r.get(3)?;
            let is_draft: bool = r.get(4)?;
            let is_outgoing: bool = r.get(5)?;
            let is_automated: bool = r.get(6)?;
            let has_attachments: bool = r.get(7)?;

            for json in [&to, &cc] {
                s.recipient_addrs.extend(
                    crate::db::repo::parse_addrs(json)
                        .into_iter()
                        .map(|a| crate::addr::normalize(&a.email)),
                );
            }
            s.recipients_raw.push(to.to_lowercase());
            s.recipients_raw.push(cc.to_lowercase());
            if !is_draft && has_attachments {
                s.has_attachment = true;
            }
            if !is_draft && !is_outgoing {
                s.senders.push(crate::addr::normalize(&from));
                s.subjects.push(fold(&subject));
                s.subjects_raw.push(subject.to_lowercase());
                // Rows are newest first, so the first inbound one wins.
                s.latest_is_automated.get_or_insert(is_automated);
            }
        }
        let mut stmt = conn.prepare_cached(
            "SELECT DISTINCT ml.label_id FROM message_labels ml
             JOIN messages m ON m.id = ml.message_id WHERE m.thread_id = ?1",
        )?;
        s.label_ids = stmt
            .query_map(params![thread_id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(s)
    }
}

/// How a subject needle is compared.
enum SubjectNeedle {
    /// Accent- and case-insensitive (`hoá đơn` finds `HÓA ĐƠN`).
    Folded(String),
    /// Case-insensitive only.
    Raw(String),
}

/// Latin-script needles are folded so accents don't matter. Any other
/// alphabet (CJK, Cyrillic, Greek, Arabic, Hebrew, Thai, ...) is matched as
/// written: folding transliterates it to ASCII, and short transliterations
/// collide - `安` folds to "an", which then also matches `电` ("dian") or
/// any English "an".
fn fold_subject_needle(value: &str) -> SubjectNeedle {
    let value = value.trim();
    let latin = |c: char| {
        !c.is_alphabetic()
            || c <= '\u{024F}'
            || ('\u{1E00}'..='\u{1EFF}').contains(&c)
            || ('\u{2C60}'..='\u{2C7F}').contains(&c)
            || ('\u{A720}'..='\u{A7FF}').contains(&c)
    };
    if value.chars().all(latin) {
        SubjectNeedle::Folded(fold(value))
    } else {
        SubjectNeedle::Raw(value.to_lowercase())
    }
}

fn text_matches(op: TextOp, hay: &str, needle: &str) -> bool {
    match op {
        TextOp::Contains => hay.contains(needle),
        TextOp::Equals => hay == needle,
        TextOp::StartsWith => hay.starts_with(needle),
        TextOp::EndsWith => hay.ends_with(needle),
    }
}

/// One leaf condition and whether it held.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeafTrace {
    pub condition: RuleCondition,
    pub passed: bool,
}

/// One rule considered while deciding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleTrace {
    pub split_id: i64,
    pub name: String,
    pub matched: bool,
    /// False when the rule has no positive criterion and can never match.
    pub matchable: bool,
    pub leaves: Vec<LeafTrace>,
    /// The condition let the thread through to this rule's AI check, whose
    /// verdict isn't known here (it ran asynchronously, if at all).
    pub ai_check: bool,
}

/// The outcome of evaluating split rules for one thread. `route` is `None`
/// when no rule matched; callers then fall back to the AI queue or heuristic.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub route: Option<RouteKey>,
    pub matched_split: Option<i64>,
    /// Only filled by [`explain`]: every rule tried, in order, up to the match.
    pub rules: Vec<RuleTrace>,
    /// A split with an AI check passed its condition before any plain rule
    /// matched: the thread must wait (`pending`) for the async AI pass.
    pub needs_ai: bool,
}

/// A thread's stored tab next to what the split rules decide for it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteExplanation {
    /// `threads.routed_tab` as stored (rule, AI, or heuristic outcome).
    pub current: Option<String>,
    pub decision: Decision,
}

/// Evaluate a condition. With `trace`, every leaf is evaluated (no
/// short-circuit) and recorded.
pub fn eval(c: &RuleCondition, s: &RuleSubject, mut trace: Option<&mut Vec<LeafTrace>>) -> bool {
    let passed = match c {
        RuleCondition::All { of } => {
            if trace.is_some() {
                of.iter()
                    .map(|c| eval(c, s, trace.as_deref_mut()))
                    .fold(true, |a, b| a && b)
            } else {
                of.iter().all(|c| eval(c, s, None))
            }
        }
        RuleCondition::Any { of } => {
            if trace.is_some() {
                of.iter()
                    .map(|c| eval(c, s, trace.as_deref_mut()))
                    .fold(false, |a, b| a || b)
            } else {
                of.iter().any(|c| eval(c, s, None))
            }
        }
        RuleCondition::Not { cond } => return !eval(cond, s, trace),
        RuleCondition::Sender { op, value } => {
            let v = crate::addr::normalize(value);
            !v.is_empty() && s.senders.iter().any(|h| text_matches(*op, h, &v))
        }
        RuleCondition::Recipient { op, value } => {
            let v = crate::addr::normalize(value);
            !v.is_empty()
                && (s.recipient_addrs.iter().any(|h| text_matches(*op, h, &v))
                    || (*op == TextOp::Contains && s.recipients_raw.iter().any(|h| h.contains(&v))))
        }
        RuleCondition::Subject { op, value } => match fold_subject_needle(value) {
            SubjectNeedle::Folded(v) => {
                !v.is_empty() && s.subjects.iter().any(|h| text_matches(*op, h, &v))
            }
            SubjectNeedle::Raw(v) => {
                !v.is_empty() && s.subjects_raw.iter().any(|h| text_matches(*op, h, &v))
            }
        },
        RuleCondition::Label { id } => s.label_ids.contains(id),
        RuleCondition::IsAutomated { value } => s.latest_is_automated == Some(*value),
        RuleCondition::HasAttachment { value } => s.has_attachment == *value,
    };
    if c.is_leaf() {
        if let Some(t) = trace {
            t.push(LeafTrace {
                condition: c.clone(),
                passed,
            });
        }
    }
    passed
}

/// Does `c` match? Unmatchable conditions (no positive criterion) never do.
pub fn matches(c: &RuleCondition, s: &RuleSubject) -> bool {
    c.is_matchable() && eval(c, s, None)
}

/// Does the split's condition let `s` through? A split with an AI check and
/// no positive condition passes everything (the AI alone decides).
pub fn gate(sp: &SplitRule, s: &RuleSubject) -> bool {
    let cond = sp.effective_condition();
    if cond.is_matchable() {
        eval(&cond, s, None)
    } else {
        sp.ai.is_some()
    }
}

/// First matching rule (in the given order) decides the route. A split with an
/// AI check that passes its condition first yields `needs_ai` instead.
pub fn decide(s: &RuleSubject, splits: &[SplitRule]) -> Decision {
    for sp in splits {
        if !gate(sp, s) {
            continue;
        }
        if sp.ai.is_some() {
            return Decision {
                needs_ai: true,
                ..Decision::default()
            };
        }
        return Decision {
            route: Some(sp.route_key()),
            matched_split: Some(sp.id),
            ..Decision::default()
        };
    }
    Decision::default()
}

/// Splits with an AI check whose condition passes, in order, up to the first
/// plain rule that matches (nothing after it can win).
pub fn ai_candidates<'a>(s: &RuleSubject, splits: &'a [SplitRule]) -> Vec<&'a SplitRule> {
    let mut out = Vec::new();
    for sp in splits {
        if !gate(sp, s) {
            continue;
        }
        if sp.ai.is_none() {
            break;
        }
        out.push(sp);
    }
    out
}

/// [`decide`] once the AI checks are answered: `ai_yes` holds the splits whose
/// check said yes; every other AI split is skipped.
pub fn decide_with_answers(
    s: &RuleSubject,
    splits: &[SplitRule],
    ai_yes: &HashSet<i64>,
) -> Decision {
    splits
        .iter()
        .find(|sp| gate(sp, s) && (sp.ai.is_none() || ai_yes.contains(&sp.id)))
        .map(|sp| Decision {
            route: Some(sp.route_key()),
            matched_split: Some(sp.id),
            ..Decision::default()
        })
        .unwrap_or_default()
}

/// Like [`decide`], but records a trace of every rule tried.
pub fn explain(s: &RuleSubject, splits: &[SplitRule]) -> Decision {
    let mut out = Decision::default();
    for sp in splits {
        let cond = sp.effective_condition();
        let mut leaves = Vec::new();
        let matchable = cond.is_matchable();
        let passed = eval(&cond, s, Some(&mut leaves)) && matchable;
        let ai_check = sp.ai.is_some() && (passed || !matchable);
        let matched = passed && sp.ai.is_none();
        out.rules.push(RuleTrace {
            split_id: sp.id,
            name: sp.name.clone(),
            matched,
            matchable: matchable || sp.ai.is_some(),
            leaves,
            ai_check,
        });
        if matched {
            out.route = Some(sp.route_key());
            out.matched_split = Some(sp.id);
            break;
        }
    }
    out
}

/// A thread a draft condition would match, for the editor's live preview.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewThread {
    pub id: i64,
    pub subject: String,
    pub from_addr: String,
    pub last_message_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionPreview {
    /// Matches among the `scanned` most recent threads.
    pub total: usize,
    pub scanned: usize,
    /// Up to `limit` newest matches.
    pub samples: Vec<PreviewThread>,
}

/// Dry-run a condition against the `scan` most recent threads.
pub fn preview(
    conn: &Connection,
    cond: &RuleCondition,
    scan: usize,
    limit: usize,
) -> Result<ConditionPreview> {
    let threads: Vec<(i64, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT id, last_message_at FROM threads ORDER BY last_message_at DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![scan as i64], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut out = ConditionPreview {
        total: 0,
        scanned: threads.len(),
        samples: Vec::new(),
    };
    if !cond.is_matchable() {
        return Ok(out);
    }
    for (id, last_message_at) in threads {
        if !eval(cond, &RuleSubject::load(conn, id)?, None) {
            continue;
        }
        out.total += 1;
        if out.samples.len() < limit {
            let (subject, from_addr) = conn.query_row(
                "SELECT COALESCE(subject,''), COALESCE(from_addr,'') FROM messages
                 WHERE thread_id = ?1 ORDER BY date DESC, id DESC LIMIT 1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            out.samples.push(PreviewThread {
                id,
                subject,
                from_addr,
                last_message_at,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SplitRuleQuery;

    fn subject() -> RuleSubject {
        RuleSubject {
            senders: vec!["noreply@github.com".into()],
            recipients_raw: vec![r#"[{"name":"team","email":"dev@acme.io"}]"#.into()],
            recipient_addrs: vec!["dev@acme.io".into()],
            subjects: vec![fold("[CI] Build failed — hóa đơn")],
            subjects_raw: vec!["[ci] build failed — hóa đơn".into()],
            label_ids: [3].into_iter().collect(),
            latest_is_automated: Some(true),
            has_attachment: false,
        }
    }

    fn sender(op: TextOp, v: &str) -> RuleCondition {
        RuleCondition::Sender {
            op,
            value: v.into(),
        }
    }

    fn not(c: RuleCondition) -> RuleCondition {
        RuleCondition::Not { cond: Box::new(c) }
    }

    fn rule(id: i64, cond: RuleCondition, target: Option<RouteKey>) -> SplitRule {
        SplitRule {
            id,
            name: format!("r{id}"),
            position: id,
            query: SplitRuleQuery::default(),
            condition: Some(cond),
            target,
            ai: None,
        }
    }

    #[test]
    fn text_ops() {
        let s = subject();
        assert!(matches(&sender(TextOp::EndsWith, "@GitHub.com"), &s));
        assert!(matches(&sender(TextOp::StartsWith, "noreply"), &s));
        assert!(matches(&sender(TextOp::Equals, "noreply@github.com"), &s));
        assert!(!matches(&sender(TextOp::Equals, "github.com"), &s));
        assert!(matches(
            &RuleCondition::Recipient {
                op: TextOp::Contains,
                value: "team".into()
            },
            &s
        ));
        assert!(matches(
            &RuleCondition::Recipient {
                op: TextOp::EndsWith,
                value: "@acme.io".into()
            },
            &s
        ));
        assert!(matches(
            &RuleCondition::Subject {
                op: TextOp::Contains,
                value: "hoá đơn".into()
            },
            &s
        ));
        assert!(matches(
            &RuleCondition::Subject {
                op: TextOp::StartsWith,
                value: "[ci]".into()
            },
            &s
        ));
    }

    #[test]
    fn matching_works_across_scripts_and_idn() {
        let s = RuleSubject {
            senders: vec![crate::addr::normalize("Rechnung@XN--MLLER-KVA.DE")],
            subjects: vec![fold("您的电费账单"), fold("Счёт за март")],
            subjects_raw: vec!["您的电费账单".into(), "счёт за март".into()],
            ..Default::default()
        };
        let sender = |v: &str| sender(TextOp::EndsWith, v);
        let subj = |v: &str| RuleCondition::Subject {
            op: TextOp::Contains,
            value: v.into(),
        };
        // A rule typed in Unicode or punycode matches mail sent either way.
        assert!(matches(&sender("@müller.de"), &s));
        assert!(matches(&sender("@Müller.DE"), &s));
        assert!(matches(&sender("@xn--mller-kva.de"), &s));
        // CJK and Cyrillic match as written, with no transliteration clashes.
        assert!(matches(&subj("电费"), &s));
        assert!(
            !matches(&subj("安"), &s),
            "安 folds to 'an', must not hit 电"
        );
        assert!(matches(&subj("СЧЁТ"), &s));
        assert!(!matches(&subj("schet"), &s), "no Latin match into Cyrillic");
    }

    #[test]
    fn own_replies_dont_make_a_thread_match_a_sender_rule() {
        use crate::db::testutil;
        let c = testutil::conn();
        testutil::seed_account(&c);
        let (t, _) = testutil::seed_message(&c, "alice@client.io", "Proposal", false);
        c.execute(
            "INSERT INTO messages (thread_id, account_id, folder_id, subject, from_addr,
             date, is_read, is_automated, is_draft, is_outgoing)
             VALUES (?1, 1, 1, 'Re: Proposal', 'me@mycompany.com', 2000, 1, 0, 0, 1)",
            params![t],
        )
        .unwrap();
        let s = RuleSubject::load(&c, t).unwrap();
        assert!(matches(&sender(TextOp::EndsWith, "@client.io"), &s));
        assert!(!matches(&sender(TextOp::EndsWith, "@mycompany.com"), &s));
    }

    #[test]
    fn boolean_tree() {
        let s = subject();
        let any = RuleCondition::Any {
            of: vec![
                sender(TextOp::Contains, "gitlab"),
                RuleCondition::Label { id: 3 },
            ],
        };
        assert!(matches(&any, &s));
        let all = RuleCondition::All {
            of: vec![any.clone(), RuleCondition::HasAttachment { value: true }],
        };
        assert!(!matches(&all, &s));
        let all = RuleCondition::All {
            of: vec![any, not(RuleCondition::HasAttachment { value: true })],
        };
        assert!(matches(&all, &s));
        // Double negation is a positive criterion again.
        assert!(matches(&not(not(sender(TextOp::Contains, "github"))), &s));
    }

    #[test]
    fn negation_only_and_empty_never_match() {
        let s = subject();
        let only_not = not(sender(TextOp::Contains, "nobody"));
        assert!(eval(&only_not, &s, None));
        assert!(!matches(&only_not, &s));
        assert!(!matches(&RuleCondition::All { of: vec![] }, &s));
        assert!(!matches(&RuleCondition::Any { of: vec![] }, &s));
        assert!(!matches(
            &RuleCondition::from(&SplitRuleQuery::default()),
            &s
        ));
    }

    #[test]
    fn legacy_query_converts_with_same_semantics() {
        let s = subject();
        let q = |f: fn(&mut SplitRuleQuery)| {
            let mut q = SplitRuleQuery::default();
            f(&mut q);
            matches(&RuleCondition::from(&q), &s)
        };
        assert!(q(|q| q.senders = Some(vec!["nope".into(), "github".into()])));
        assert!(!q(|q| q.senders = Some(vec!["  ".into()])));
        assert!(q(|q| q.recipients = Some(vec!["acme.io".into()])));
        assert!(q(|q| q.subject_contains = Some(vec!["HOA DON".into()])));
        assert!(q(|q| q.labels = Some(vec![9, 3])));
        assert!(!q(|q| q.labels = Some(vec![0])));
        assert!(q(|q| q.is_automated = Some(true)));
        assert!(!q(|q| q.is_automated = Some(false)));
        assert!(q(|q| q.has_attachment = Some(false)));
        // Exclusions veto, and never match on their own.
        assert!(!q(|q| q.exclude_senders = Some(vec!["nobody".into()])));
        assert!(!q(|q| {
            q.senders = Some(vec!["github".into()]);
            q.exclude_senders = Some(vec!["noreply@".into()]);
        }));
        assert!(q(|q| {
            q.senders = Some(vec!["github".into()]);
            q.exclude_senders = Some(vec!["nobody".into()]);
        }));
    }

    #[test]
    fn decide_picks_first_match_and_explain_traces() {
        let s = subject();
        let rules = vec![
            rule(1, sender(TextOp::Contains, "gitlab"), None),
            rule(2, not(RuleCondition::Label { id: 3 }), None),
            rule(3, RuleCondition::Label { id: 3 }, Some(RouteKey::Important)),
            rule(4, sender(TextOp::Contains, "github"), None),
        ];
        let d = decide(&s, &rules);
        assert_eq!(d.route, Some(RouteKey::Important));
        assert_eq!(d.matched_split, Some(3));
        assert!(d.rules.is_empty());

        let e = explain(&s, &rules);
        assert_eq!(e.route, d.route);
        assert_eq!(e.rules.len(), 3);
        assert!(!e.rules[0].matched);
        assert!(!e.rules[1].matchable);
        assert_eq!(e.rules[2].leaves.len(), 1);
        assert!(e.rules[2].leaves[0].passed);

        assert_eq!(decide(&s, &rules[..2]), Decision::default());
        assert_eq!(
            decide(&s, &rules[3..]).route,
            Some(RouteKey::Split(4)),
            "untargeted rule is its own tab"
        );
    }

    #[test]
    fn route_key_roundtrip() {
        for k in [
            RouteKey::Important,
            RouteKey::Other,
            RouteKey::Pending,
            RouteKey::Label(5),
            RouteKey::Split(12),
        ] {
            assert_eq!(k.to_string().parse::<RouteKey>(), Ok(k));
            let json = serde_json::to_string(&k).unwrap();
            assert_eq!(serde_json::from_str::<RouteKey>(&json).unwrap(), k);
        }
        for bad in [
            "",
            "label:",
            "label:x",
            "split:-1",
            "label:0",
            "Important",
            "inbox",
        ] {
            assert!(bad.parse::<RouteKey>().is_err(), "{bad}");
        }
    }

    #[test]
    fn validate_limits() {
        let ids = [3];
        assert!(sender(TextOp::Contains, "x").validate(&ids).is_empty());
        let errs = RuleCondition::All {
            of: vec![
                sender(TextOp::Contains, " "),
                RuleCondition::Label { id: 99 },
                RuleCondition::Any { of: vec![] },
            ],
        }
        .validate(&ids);
        use crate::models::RuleConditionError as E;
        assert!(errs.contains(&E::EmptyValue));
        assert!(errs.contains(&E::UnknownLabel { id: 99 }));
        assert!(errs.contains(&E::EmptyGroup));
        assert!(
            not(RuleCondition::Label { id: 3 })
                .validate(&ids)
                .contains(&E::NotMatchable)
        );
        let mut deep = RuleCondition::Label { id: 3 };
        for _ in 0..8 {
            deep = RuleCondition::All { of: vec![deep] };
        }
        assert!(deep.validate(&ids).contains(&E::TooDeep));
        let wide = RuleCondition::Any {
            of: (0..64).map(|_| RuleCondition::Label { id: 3 }).collect(),
        };
        assert!(wide.validate(&ids).contains(&E::TooLarge));
    }

    #[test]
    fn ai_checks_gate_and_order() {
        let s = subject();
        let check = || {
            Some(crate::models::AiCheck {
                instruction: "is it a build failure".into(),
                min_confidence: None,
            })
        };
        // AI split whose condition passes, ahead of a plain match.
        let mut ai = rule(1, sender(TextOp::EndsWith, "@github.com"), None);
        ai.ai = check();
        let plain = rule(2, sender(TextOp::Contains, "github"), None);
        // AI-only split (no condition) gates everything through.
        let mut ai_only = rule(3, RuleCondition::All { of: vec![] }, None);
        ai_only.ai = check();
        // A non-matching AI split is never a candidate.
        let mut ai_miss = rule(4, sender(TextOp::EndsWith, "@nope.test"), None);
        ai_miss.ai = check();

        let splits = vec![ai_miss.clone(), ai.clone(), plain.clone(), ai_only.clone()];
        let d = decide(&s, &splits);
        assert!(d.needs_ai && d.route.is_none());
        let ids: Vec<i64> = ai_candidates(&s, &splits).iter().map(|r| r.id).collect();
        assert_eq!(ids, vec![1], "stops at the first plain match");

        let yes: HashSet<i64> = [1].into();
        assert_eq!(
            decide_with_answers(&s, &splits, &yes).matched_split,
            Some(1)
        );
        let no = HashSet::new();
        assert_eq!(decide_with_answers(&s, &splits, &no).matched_split, Some(2));

        let only = vec![ai_only];
        assert!(decide(&s, &only).needs_ai);
        assert_eq!(decide_with_answers(&s, &only, &no).route, None);
        let t = explain(&s, &splits);
        assert!(
            t.rules
                .iter()
                .any(|r| r.split_id == 1 && r.ai_check && !r.matched)
        );
    }
}
