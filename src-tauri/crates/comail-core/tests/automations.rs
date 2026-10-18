//! Automation rules on new mail: deterministic conditions (the rule decision
//! API), AI instructions answered by a decision model (a local stand-in for
//! TypeSafe Jev), and the "provider down" path that must leave mail for a
//! later retry instead of dropping or blocking it.

use comail_core::Core;
use comail_core::config::Paths;
use comail_core::db::{Db, repo};
use comail_core::models::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A localhost port with nothing listening: connections are refused instantly.
fn dead_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

/// Minimal OpenRouter-dialect decisions endpoint: every `noul` question gets
/// `probability`, every `choice` question `choice` (or its first option).
/// Returns the port and the captured request bodies.
async fn fake_decisions(probability: f64) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    fake_decisions_with(probability, None).await
}

async fn fake_decisions_with(
    probability: f64,
    choice: Option<&'static str>,
) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let log = log.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                // Read headers, then exactly Content-Length body bytes.
                let body = loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                        let len = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if rest.len() >= len {
                            break rest.to_string();
                        }
                    }
                };
                let req: serde_json::Value = serde_json::from_str(&body).unwrap();
                log.lock().unwrap().push(body);
                let mut answers = serde_json::Map::new();
                for (name, q) in req["questions"].as_object().unwrap() {
                    if q["type"] == "noul" {
                        answers.insert(
                            name.clone(),
                            serde_json::json!({"type": "noul", "noul": probability}),
                        );
                    } else if q["type"] == "choice" {
                        let first = q["criteria"]
                            .as_object()
                            .unwrap()
                            .keys()
                            .next()
                            .unwrap()
                            .clone();
                        answers.insert(
                            name.clone(),
                            serde_json::json!({
                                "type": "choice",
                                "choice": choice.map(str::to_string).unwrap_or(first),
                                "confidence": 0.9,
                            }),
                        );
                    }
                }
                let out = serde_json::json!({
                    "model": req["model"],
                    "answers": answers,
                    "usage": {"input_tokens": 12, "output_tokens": 0},
                })
                .to_string();
                let resp = format!(
                    "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{out}",
                    out.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            });
        }
    });
    (port, seen)
}

fn rule(
    id: &str,
    instruction: &str,
    condition: Option<RuleCondition>,
    prefix: &str,
) -> AiAutomationRule {
    AiAutomationRule {
        id: id.into(),
        name: id.into(),
        source_prompt: String::new(),
        instruction: instruction.into(),
        enabled: true,
        actions: vec![AiAutomationAction {
            kind: "subject_prefix".into(),
            value: prefix.into(),
        }],
        condition,
        min_confidence: None,
    }
}

/// Seed an offline account, three inbound messages (two recent, one too old
/// to automate) and the settings, all before the core starts.
async fn seed(db: &Db, settings: Settings) -> Vec<i64> {
    db.write(move |conn| {
        let port = dead_port();
        let account_id = repo::accounts::insert(
            conn,
            &repo::accounts::NewAccount {
                email: "me@example.com",
                display_name: None,
                provider: Provider::Imap,
                auth_kind: AuthKind::Password,
                username: "me",
                imap_host: "127.0.0.1",
                imap_port: port,
                smtp_host: "127.0.0.1",
                smtp_port: port,
            },
        )?;
        let inbox = repo::folders::upsert(conn, account_id, "INBOX", None, Some(roles::INBOX))?;
        let day = 24 * 60 * 60 * 1000;
        let mut ids = Vec::new();
        for (i, (from, subject, age)) in [
            ("billing@vendor.test", "Invoice 1042", 0),
            ("friend@pals.test", "Dinner?", 0),
            ("billing@vendor.test", "Invoice 0999", 10 * day),
        ]
        .into_iter()
        .enumerate()
        {
            let thread_id = repo::threads::create(conn, account_id, None, subject)?;
            let msg = repo::messages::NewMessage {
                account_id,
                folder_id: inbox,
                uid: Some(i as i64 + 1),
                message_id: Some(format!("m{i}@example.com")),
                gm_msgid: None,
                gm_thrid: None,
                subject: subject.into(),
                from: Some(Address {
                    name: None,
                    email: from.into(),
                }),
                to: vec![Address {
                    name: None,
                    email: "me@example.com".into(),
                }],
                cc: vec![],
                bcc: vec![],
                date: now_ms() - age,
                internal_date: None,
                is_read: false,
                is_starred: false,
                is_draft: false,
                is_outgoing: false,
                is_automated: false,
                has_attachments: false,
                size: None,
                snippet: "amount due".into(),
                references: vec![],
                list_unsubscribe: None,
                list_unsubscribe_post: None,
                sender_addr: None,
            };
            repo::messages::insert(conn, &msg, thread_id)?;
            repo::threads::recompute(conn, thread_id)?;
            ids.push(thread_id);
        }
        repo::settings::set(conn, &settings)?;
        Ok(ids)
    })
    .await
    .expect("seed")
}

/// (local subject prefix, automations_applied) of each thread's message.
async fn state(db: &Db, threads: &[i64]) -> Vec<(String, bool)> {
    let threads = threads.to_vec();
    db.read(move |conn| {
        let mut out = Vec::new();
        for t in threads {
            out.push(conn.query_row(
                "SELECT COALESCE(local_subject_prefix,''), automations_applied
                 FROM messages WHERE thread_id = ?1",
                [t],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?);
        }
        Ok(out)
    })
    .await
    .unwrap()
}

fn vendor_condition() -> RuleCondition {
    RuleCondition::Sender {
        op: TextOp::EndsWith,
        value: "@vendor.test".into(),
    }
}

fn insecure_creds() {
    let file = std::env::temp_dir().join(format!("comail-auto-creds-{}.json", std::process::id()));
    // SAFETY: set before the core (and its threads) start; same value per process.
    unsafe { std::env::set_var("COMAIL_CREDENTIALS_INSECURE_FILE", &file) };
}

#[tokio::test(flavor = "multi_thread")]
async fn condition_and_decision_model_rules_apply_once() {
    insecure_creds();
    let (port, seen) = fake_decisions(0.9).await;
    let tmp = tempfile::tempdir().unwrap();
    let paths = Paths::for_tests(tmp.path());
    paths.ensure().unwrap();
    let db = Db::open(&paths.db_file()).unwrap();

    let mut settings = Settings::default();
    settings.decision_provider = "custom".into();
    settings.decision_base_url = format!("http://127.0.0.1:{port}/api/alpha/decisions");
    settings.decision_model = "typesafe/jev-1.14".into();
    settings.ai_automation_rules = vec![
        // Deterministic only: no model call.
        rule("vendor", "", Some(vendor_condition()), "[V] "),
        // Condition-gated AI rule: only vendor mail is asked about.
        rule(
            "invoice",
            "It is an invoice",
            Some(vendor_condition()),
            "[INV] ",
        ),
    ];
    let threads = seed(&db, settings).await;

    let core = Core::start(Paths::for_tests(tmp.path())).await.unwrap();
    // The background router may race us; both paths converge on one result.
    while core.run_automations(50).await.unwrap() > 0 {}

    let s = state(&db, &threads).await;
    assert_eq!(
        s[0],
        ("[V] [INV] ".to_string(), true),
        "both rules, in rule order"
    );
    assert_eq!(
        s[1],
        (String::new(), true),
        "no rule matched, still settled"
    );
    assert_eq!(s[2], (String::new(), true), "too old to automate");

    let bodies = seen.lock().unwrap().clone();
    assert_eq!(
        bodies.len(),
        1,
        "one decision call, only for the gated thread"
    );
    assert!(bodies[0].contains("\"noul\"") && bodies[0].contains("Invoice 1042"));

    // Once per message: a second pass changes nothing.
    assert_eq!(core.run_automations(50).await.unwrap(), 0);
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn decision_provider_down_retries_later() {
    insecure_creds();
    let tmp = tempfile::tempdir().unwrap();
    let paths = Paths::for_tests(tmp.path());
    paths.ensure().unwrap();
    let db = Db::open(&paths.db_file()).unwrap();

    let mut settings = Settings::default();
    settings.decision_provider = "custom".into();
    settings.decision_base_url = format!("http://127.0.0.1:{}/api/alpha/decisions", dead_port());
    settings.ai_automation_rules = vec![rule("invoice", "It is an invoice", None, "[INV] ")];
    let threads = seed(&db, settings).await;

    let core = Core::start(Paths::for_tests(tmp.path())).await.unwrap();
    assert!(core.run_automations(50).await.is_err(), "every call failed");
    let s = state(&db, &threads).await;
    assert_eq!(s[0], (String::new(), false), "left for a later retry");
    assert_eq!(s[1], (String::new(), false), "left for a later retry");
    assert_eq!(s[2], (String::new(), true), "too old to automate");
}

/// Each thread's stored tab.
async fn tabs(db: &Db, threads: &[i64]) -> Vec<Option<String>> {
    let threads = threads.to_vec();
    db.read(move |conn| {
        let mut out = Vec::new();
        for t in threads {
            out.push(
                conn.query_row("SELECT routed_tab FROM threads WHERE id = ?1", [t], |r| {
                    r.get(0)
                })?,
            );
        }
        Ok(out)
    })
    .await
    .unwrap()
}

fn invoice_split_check() -> AiCheck {
    AiCheck {
        instruction: "It is an invoice".into(),
        min_confidence: None,
    }
}

/// Split rules with an AI check: the decision model answers it, a dead primary
/// falls through to the backup, and with no AI at all the check counts as
/// "no" instead of leaving mail stuck as pending.
#[tokio::test(flavor = "multi_thread")]
async fn split_ai_check_uses_backup_and_works_without_ai() {
    insecure_creds();
    let (port, seen) = fake_decisions(0.9).await;
    for with_ai in [true, false] {
        let tmp = tempfile::tempdir().unwrap();
        let paths = Paths::for_tests(tmp.path());
        paths.ensure().unwrap();
        let db = Db::open(&paths.db_file()).unwrap();
        let mut settings = Settings::default();
        if with_ai {
            // Primary is down; the backup answers.
            settings.decision_provider = "custom".into();
            settings.decision_base_url =
                format!("http://127.0.0.1:{}/api/alpha/decisions", dead_port());
            settings.decision_backups = vec![DecisionEndpoint {
                provider: "custom".into(),
                model: "typesafe/jev-1.14".into(),
                base_url: format!("http://127.0.0.1:{port}/api/alpha/decisions"),
                format: "openrouter".into(),
            }];
        }
        let threads = seed(&db, settings).await;
        let core = Core::start(Paths::for_tests(tmp.path())).await.unwrap();
        let split = core
            .save_split(
                None,
                "Invoices".into(),
                0,
                SplitRuleQuery::default(),
                Some(RuleCondition::Sender {
                    op: TextOp::EndsWith,
                    value: "@vendor.test".into(),
                }),
                None,
                Some(invoice_split_check()),
                false,
                true,
            )
            .await
            .unwrap();
        core.reroute_all().await.unwrap();
        while core.classify_pending(50).await.unwrap() > 0 {}

        let t = tabs(&db, &threads).await;
        let key = format!("split:{}", split.id);
        if with_ai {
            assert_eq!(t[0].as_deref(), Some(key.as_str()), "AI said invoice");
            assert_eq!(
                t[2].as_deref(),
                Some(key.as_str()),
                "old mail re-sorted too"
            );
        } else {
            assert_ne!(t[0].as_deref(), Some(key.as_str()), "no AI: check is no");
        }
        assert_ne!(
            t[1].as_deref(),
            Some(key.as_str()),
            "condition gates the check"
        );
        assert!(
            t.iter().all(|k| k.as_deref() != Some("pending")),
            "nothing left pending: {t:?}"
        );
    }
    let bodies = seen.lock().unwrap().clone();
    assert!(!bodies.is_empty());
    assert!(
        bodies.iter().all(|b| !b.contains("Dinner")),
        "only gated threads are sent to the model"
    );
}

/// A custom category is offered to the decision model and routes mail.
#[tokio::test(flavor = "multi_thread")]
async fn custom_category_is_chosen_by_decision_model() {
    insecure_creds();
    let (port, seen) = fake_decisions_with(0.9, Some("Receipts")).await;
    let tmp = tempfile::tempdir().unwrap();
    let paths = Paths::for_tests(tmp.path());
    paths.ensure().unwrap();
    let db = Db::open(&paths.db_file()).unwrap();
    let mut settings = Settings::default();
    settings.ai_categorize = true;
    settings.decision_provider = "custom".into();
    settings.decision_base_url = format!("http://127.0.0.1:{port}/api/alpha/decisions");
    let threads = seed(&db, settings).await;
    let core = Core::start(Paths::for_tests(tmp.path())).await.unwrap();
    let cat = core
        .create_category(
            "Receipts".into(),
            "#888888".into(),
            "Purchase receipts".into(),
        )
        .await
        .unwrap();
    assert!(cat.is_auto);
    core.reroute_all().await.unwrap();
    while core.classify_pending(50).await.unwrap() > 0 {}

    let t = tabs(&db, &threads).await;
    let key = format!("label:{}", cat.id);
    assert_eq!(t[0].as_deref(), Some(key.as_str()), "{t:?}");
    let bodies = seen.lock().unwrap().clone();
    assert!(
        bodies.iter().any(|b| b.contains("Purchase receipts")),
        "guidance sent"
    );
}

/// A rule's own confidence bar overrides the global one.
#[tokio::test(flavor = "multi_thread")]
async fn per_rule_confidence_overrides_global() {
    insecure_creds();
    let (port, _) = fake_decisions(0.8).await;
    let tmp = tempfile::tempdir().unwrap();
    let paths = Paths::for_tests(tmp.path());
    paths.ensure().unwrap();
    let db = Db::open(&paths.db_file()).unwrap();
    let mut settings = Settings::default();
    settings.decision_provider = "custom".into();
    settings.decision_base_url = format!("http://127.0.0.1:{port}/api/alpha/decisions");
    let mut strict = rule(
        "strict",
        "It is an invoice",
        Some(vendor_condition()),
        "[S] ",
    );
    strict.min_confidence = Some(0.95);
    let lenient = rule(
        "lenient",
        "It is an invoice",
        Some(vendor_condition()),
        "[L] ",
    );
    settings.ai_automation_rules = vec![strict, lenient];
    let threads = seed(&db, settings).await;
    let core = Core::start(Paths::for_tests(tmp.path())).await.unwrap();
    while core.run_automations(50).await.unwrap() > 0 {}
    let s = state(&db, &threads).await;
    assert_eq!(s[0].0, "[L] ", "0.8 passes the global 0.6 but not 0.95");
}
