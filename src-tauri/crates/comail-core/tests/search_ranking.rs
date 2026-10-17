//! Search quality: accent-insensitive contact suggestions, the đ/d query
//! variant, OR fallback for multi-term queries, and affinity-personalized
//! ranking.

use comail_core::db::repo;
use comail_core::models::Address;
use comail_core::search;
use rusqlite::Connection;

fn db() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    comail_core::db::migrations::run(&mut conn).unwrap();
    conn.execute_batch(
        "INSERT INTO accounts (id,email,provider,auth_kind,username,imap_host,imap_port,smtp_host,smtp_port,created_at)
           VALUES (1,'me@example.com','imap','password','me','h',993,'h',465,0);
         INSERT INTO folders (id,account_id,imap_name,role) VALUES (1,1,'INBOX','inbox');",
    )
    .unwrap();
    conn
}

fn addr(name: &str, email: &str) -> Address {
    Address {
        name: Some(name.to_string()),
        email: email.to_string(),
    }
}

fn insert_message(
    conn: &Connection,
    id: i64,
    thread: i64,
    subject: &str,
    from: &Address,
    date: i64,
) {
    conn.execute(
        "INSERT OR IGNORE INTO threads (id,account_id,subject_norm,last_message_at,message_count)
         VALUES (?1,1,?2,?3,1)",
        rusqlite::params![thread, subject.to_lowercase(), date],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO messages (id,account_id,thread_id,folder_id,uid,subject,from_name,from_addr,date,is_read,body_state)
         VALUES (?1,1,?2,1,?1,?3,?4,?5,?6,1,'cached')",
        rusqlite::params![id, thread, subject, from.name, from.email, date],
    )
    .unwrap();
    repo::search::index_message(conn, id).unwrap();
}

#[test]
fn fold_strips_vietnamese_diacritics() {
    assert_eq!(search::fold("Bé Dọn Dẹp"), "be don dep");
    assert_eq!(search::fold("Đơn hàng"), "don hang");
    assert_eq!(search::fold("Café Ñandú"), "cafe nandu");
}

#[test]
fn suggest_matches_unaccented_input_ranked_by_affinity() {
    let conn = db();
    let cleaner = addr("Bé Dọn Dẹp", "hello@begroup.vn");
    let noise = addr("Ben Porter", "ben@example.com");
    // The cleaner writes often; Ben once.
    for i in 0..10 {
        repo::contacts::harvest(&conn, 1, &cleaner, false, 1000 + i).unwrap();
    }
    repo::contacts::harvest(&conn, 1, &noise, false, 2000).unwrap();

    let hits = repo::contacts::suggest(&conn, "be don dep", None, 5).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].email, "hello@begroup.vn");
    assert_eq!(hits[0].interactions, 10);

    // Single token: both match, the frequent contact first.
    let hits = repo::contacts::suggest(&conn, "be", None, 5).unwrap();
    assert_eq!(hits[0].email, "hello@begroup.vn");
    assert!(hits.iter().any(|c| c.email == "ben@example.com"));
}

#[test]
fn autocomplete_backfill_covers_pre_fold_rows() {
    let conn = db();
    conn.execute(
        "INSERT INTO contacts (email,name,send_count,recv_count,last_interacted)
         VALUES ('x@y.vn','Trần Đức',0,3,1)",
        [],
    )
    .unwrap();
    // Row predates the folded column; suggest can't see it until backfill.
    assert!(
        repo::contacts::suggest(&conn, "tran duc", None, 5)
            .unwrap()
            .is_empty()
    );
    repo::contacts::backfill_folded(&conn).unwrap();
    let hits = repo::contacts::suggest(&conn, "tran duc", None, 5).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].email, "x@y.vn");
}

#[test]
fn unaccented_query_finds_accented_mail_including_leading_d() {
    let conn = db();
    let be = addr("BE GROUP", "hi@begroup.vn");
    insert_message(&conn, 100, 10, "Bé dọn dẹp nhà cuối tuần", &be, 1_000);
    insert_message(&conn, 101, 20, "Đơn hàng của bạn", &be, 2_000);

    let q = search::parse("don dep");
    let hits = repo::search::hybrid(&conn, &q, &[], 10).unwrap();
    assert_eq!(hits[0].id, 10, "vowel diacritics fold at index time");

    let q = search::parse("don hang");
    let hits = repo::search::hybrid(&conn, &q, &[], 10).unwrap();
    assert!(
        hits.iter().any(|t| t.id == 20),
        "leading đ matched via the d-variant expansion"
    );
}

#[test]
fn multi_term_query_falls_back_to_or_when_and_is_empty() {
    let conn = db();
    let be = addr("BE GROUP", "hi@begroup.vn");
    insert_message(&conn, 100, 10, "House cleaning schedule", &be, 1_000);

    // "cleaning zzzqx": no message has both terms - OR fallback still finds it.
    let q = search::parse("cleaning zzzqx");
    let hits = repo::search::hybrid(&conn, &q, &[], 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, 10);
}

#[test]
fn frequent_sender_outranks_equal_match_from_stranger() {
    let conn = db();
    let friend = addr("BE GROUP", "hi@begroup.vn");
    let stranger = addr("Random Shop", "noreply@shop.com");
    // Same subject and date, so bm25 and recency tie; only affinity differs.
    insert_message(&conn, 100, 10, "House cleaning offer", &stranger, 5_000);
    insert_message(&conn, 101, 20, "House cleaning offer", &friend, 5_000);
    for i in 0..20 {
        repo::contacts::harvest(&conn, 1, &friend, i % 2 == 0, 1000 + i).unwrap();
    }
    repo::contacts::harvest(&conn, 1, &stranger, false, 1000).unwrap();

    let q = search::parse("house cleaning");
    let hits = repo::search::hybrid(&conn, &q, &[], 10).unwrap();
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].id, 20, "high-affinity sender ranks first");
}

#[test]
fn sender_name_match_outranks_body_only_match() {
    let conn = db();
    let be = addr("Bé Dọn Dẹp", "hello@begroup.vn");
    let other = addr("Random Shop", "noreply@shop.com");
    // Same date; "be" appears in the stranger's subject but IS the friend's name.
    insert_message(
        &conn,
        100,
        10,
        "Best deals to be had this week",
        &other,
        5_000,
    );
    insert_message(&conn, 101, 20, "Lịch dọn nhà tuần này", &be, 5_000);

    let q = search::parse("be");
    let hits = repo::search::hybrid(&conn, &q, &[], 10).unwrap();
    assert_eq!(
        hits[0].id, 20,
        "query matching the sender's name ranks that sender first"
    );
}

#[test]
fn exclude_operator_drops_matching_threads() {
    let conn = db();
    let be = addr("BE GROUP", "hi@begroup.vn");
    insert_message(&conn, 100, 10, "Quarterly report final", &be, 2_000);
    insert_message(&conn, 101, 20, "Quarterly report draft", &be, 1_000);

    // Plain query returns both threads.
    let q = search::parse("quarterly report");
    let hits = repo::search::hybrid(&conn, &q, &[], 10).unwrap();
    assert_eq!(hits.len(), 2);

    // "exclude:draft" drops the thread whose subject matches "draft".
    let q = search::parse("quarterly report exclude:draft");
    let hits = repo::search::hybrid(&conn, &q, &[], 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, 10);

    // The Gmail-style "-draft" is equivalent.
    let q = search::parse("quarterly report -draft");
    let hits = repo::search::hybrid(&conn, &q, &[], 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, 10);
}

#[test]
fn exclude_only_query_lists_all_non_matching_mail() {
    let conn = db();
    let be = addr("BE GROUP", "hi@begroup.vn");
    insert_message(&conn, 100, 10, "House cleaning offer", &be, 2_000);
    insert_message(&conn, 101, 20, "Draft agreement", &be, 1_000);

    // No positive terms, only an exclusion: everything except the "draft" thread.
    let q = search::parse("-draft");
    let hits = repo::search::hybrid(&conn, &q, &[], 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, 10);
}

#[test]
fn from_operator_survives_trailing_comma() {
    let conn = db();
    let be = addr("BE GROUP", "hi@begroup.vn");
    insert_message(&conn, 100, 10, "Software proposal", &be, 1_000);

    let q = search::parse("from:hi@begroup.vn, software");
    let hits = repo::search::hybrid(&conn, &q, &[], 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, 10);
}

// ---------- tiered, personalised ranking ----------

const DAY: i64 = 86_400_000;

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Give message `id` a body and re-index it.
fn set_body(conn: &Connection, id: i64, body: &str) {
    repo::messages::store_body(conn, id, Some(body), None, None, false, Some(body)).unwrap();
    repo::search::index_message(conn, id).unwrap();
}

fn exec(conn: &Connection, sql: &str) {
    conn.execute_batch(sql).unwrap();
}

/// Rank with explicit vector hits and return (thread id, tier, reason).
fn ranked(conn: &Connection, query: &str, vec_hits: &[(i64, f32)]) -> Vec<(i64, u8, String)> {
    let q = search::parse(query);
    let lex = repo::search::lexical_candidates(conn, &q, 200).unwrap();
    let out = repo::search::rank(conn, &q, lex, vec_hits, 50, now()).unwrap();
    out.threads
        .iter()
        .zip(&out.hits)
        .map(|(t, h)| (t.id, h.tier, format!("{:?}", h.reason).to_lowercase()))
        .collect()
}

fn ids(r: &[(i64, u8, String)]) -> Vec<i64> {
    r.iter().map(|(id, _, _)| *id).collect()
}

#[test]
fn tiers_put_exact_keyword_matches_first_whatever_else_favours_the_rest() {
    let conn = db();
    let me_friend = addr("Close Friend", "friend@example.com");
    let stranger = addr("Some Vendor", "sales@vendor.com");
    let t = now();
    // T1: both words in the subject, old, from a stranger.
    insert_message(
        &conn,
        100,
        10,
        "Quarterly budget review",
        &stranger,
        t - 300 * DAY,
    );
    // T2: both words, but only in the body - fresh, from a close friend.
    insert_message(&conn, 101, 20, "Catching up", &me_friend, t);
    set_body(
        &conn,
        101,
        "the quarterly numbers and the budget are attached",
    );
    // T3: only one of the words - fresh, close friend.
    insert_message(&conn, 102, 30, "Budget for the party", &me_friend, t);
    // T4: no keyword at all, but the vector index loves it.
    insert_message(&conn, 103, 40, "Finance planning notes", &me_friend, t);
    for i in 0..30 {
        repo::contacts::harvest(&conn, 1, &me_friend, true, 1000 + i).unwrap();
    }

    let r = ranked(&conn, "quarterly budget", &[(103, 0.95), (101, 0.90)]);
    assert_eq!(ids(&r), vec![10, 20, 30, 40]);
    let tiers: Vec<u8> = r.iter().map(|x| x.1).collect();
    assert_eq!(tiers, vec![1, 3, 4, 5]);
    let reasons: Vec<&str> = r.iter().map(|x| x.2.as_str()).collect();
    assert_eq!(reasons, vec!["subject", "content", "partial", "similar"]);
}

#[test]
fn sender_name_match_is_top_tier() {
    let conn = db();
    insert_message(
        &conn,
        100,
        10,
        "Weekly digest",
        &addr("Hùng Nguyễn", "hung@x.vn"),
        1_000,
    );
    insert_message(&conn, 101, 20, "Notes", &addr("Lan", "lan@x.vn"), 2_000);
    set_body(&conn, 101, "ask hùng about it");
    let r = ranked(&conn, "hùng", &[]);
    assert_eq!(r[0], (10, 1, "sender".to_string()));
    assert_eq!(r[1].0, 20);
    assert_eq!(r[1].1, 3);
}

#[test]
fn whole_word_and_exact_accent_rank_first_within_a_tier() {
    let conn = db();
    let a = addr("Shop", "shop@x.com");
    let t = now();
    // Same tier (subject), same date: whole word beats prefix.
    insert_message(&conn, 100, 10, "Certification program", &a, t);
    insert_message(&conn, 101, 20, "Your cert is ready", &a, t);
    assert_eq!(ids(&ranked(&conn, "cert", &[]))[0], 20);

    // Accented query: exact accent beats folded match.
    insert_message(&conn, 102, 30, "Hưng Phú Automation", &a, t);
    insert_message(&conn, 103, 40, "Hùng Thắng onsite", &a, t);
    assert_eq!(ids(&ranked(&conn, "hùng", &[]))[0], 40);
    // Unaccented query: both match equally well, so both are top tier.
    let r = ranked(&conn, "hung", &[]);
    assert!(
        r.iter()
            .filter(|x| x.0 == 30 || x.0 == 40)
            .all(|x| x.1 == 1)
    );
}

#[test]
fn replied_starred_and_opened_threads_rank_up_within_a_tier() {
    let conn = db();
    let t = now();
    let s = addr("Vendor", "v@x.com");
    insert_message(&conn, 100, 10, "Invoice March", &s, t);
    insert_message(&conn, 101, 20, "Invoice March", &s, t);
    // Thread 20: I replied in it.
    exec(
        &conn,
        &format!(
            "INSERT INTO messages (id,account_id,thread_id,folder_id,uid,subject,from_addr,date,is_read,is_outgoing,body_state)
             VALUES (102,1,20,1,102,'Re: Invoice March','me@example.com',{t},1,1,'cached')"
        ),
    );
    assert_eq!(
        ids(&ranked(&conn, "invoice", &[]))[0],
        20,
        "replied thread first"
    );

    // Opening thread 10 from search a few times lifts it above.
    for _ in 0..3 {
        repo::search_history::record(&conn, "invoice", 10, t).unwrap();
    }
    exec(&conn, "UPDATE messages SET is_outgoing = 0 WHERE id = 102");
    assert_eq!(
        ids(&ranked(&conn, "invoice", &[]))[0],
        10,
        "learned from opens"
    );
}

#[test]
fn opens_of_a_sender_lift_their_other_mail() {
    let conn = db();
    let t = now();
    let boss = addr("Boss", "boss@x.com");
    let other = addr("Other", "other@x.com");
    insert_message(&conn, 100, 10, "Report draft", &other, t);
    insert_message(&conn, 101, 20, "Report draft", &boss, t);
    insert_message(&conn, 102, 30, "Lunch", &boss, t);
    for _ in 0..4 {
        repo::search_history::record(&conn, "lunch", 30, t).unwrap();
    }
    assert_eq!(ids(&ranked(&conn, "report", &[]))[0], 20);
}

#[test]
fn automated_mail_ranks_below_people() {
    let conn = db();
    let t = now();
    insert_message(
        &conn,
        100,
        10,
        "Shipping update",
        &addr("Store", "noreply@store.com"),
        t,
    );
    insert_message(
        &conn,
        101,
        20,
        "Shipping update",
        &addr("Mai", "mai@x.vn"),
        t,
    );
    exec(&conn, "UPDATE messages SET is_automated = 1 WHERE id = 100");
    assert_eq!(ids(&ranked(&conn, "shipping", &[]))[0], 20);
}

#[test]
fn weak_semantic_hits_are_dropped() {
    let conn = db();
    let a = addr("A", "a@x.com");
    insert_message(&conn, 100, 10, "alpha", &a, 1_000);
    insert_message(&conn, 101, 20, "beta", &a, 1_000);
    insert_message(&conn, 102, 30, "gamma", &a, 1_000);
    // 0.40 is under the absolute floor; 0.70 is too far below the best 0.90.
    let r = ranked(
        &conn,
        "zzzunmatched",
        &[(100, 0.90), (101, 0.70), (102, 0.40)],
    );
    assert_eq!(ids(&r), vec![10]);
    assert_eq!(r[0].2, "similar");
}

#[test]
fn sort_oldest_and_newest_order_within_tiers() {
    let conn = db();
    let a = addr("A", "a@x.com");
    insert_message(&conn, 100, 10, "Payroll January", &a, 1_000);
    insert_message(&conn, 101, 20, "Payroll February", &a, 2_000);
    insert_message(&conn, 102, 30, "Notes", &a, 500);
    set_body(&conn, 102, "payroll mentioned in passing");
    assert_eq!(
        ids(&ranked(&conn, "payroll sort:oldest", &[])),
        vec![10, 20, 30]
    );
    assert_eq!(
        ids(&ranked(&conn, "payroll sort:newest", &[])),
        vec![20, 10, 30]
    );
}

#[test]
fn operator_only_queries_list_newest_first() {
    let conn = db();
    let a = addr("Alice", "alice@x.com");
    insert_message(&conn, 100, 10, "one", &a, 1_000);
    insert_message(&conn, 101, 20, "two", &a, 3_000);
    insert_message(&conn, 102, 30, "three", &a, 2_000);
    let r = ranked(&conn, "from:alice", &[]);
    assert_eq!(ids(&r), vec![20, 30, 10]);
    assert!(r.iter().all(|x| x.2 == "filter"));
    assert_eq!(
        ids(&ranked(&conn, "from:alice sort:oldest", &[])),
        vec![10, 30, 20]
    );
}

#[test]
fn label_filter_by_name_prefix_and_auto_route() {
    let conn = db();
    let a = addr("A", "a@x.com");
    insert_message(&conn, 100, 10, "Contract draft", &a, 1_000);
    insert_message(&conn, 101, 20, "Contract signed", &a, 2_000);
    insert_message(&conn, 102, 30, "Contract promo", &a, 3_000);
    let follow = repo::labels::save(&conn, None, "Follow up", "#f00", 0).unwrap();
    repo::labels::add_to_message(&conn, 100, follow.id).unwrap();
    // Thread 30 is in the auto "Marketing" category via routing only.
    let marketing: i64 = conn
        .query_row("SELECT id FROM labels WHERE name = 'Marketing'", [], |r| {
            r.get(0)
        })
        .unwrap();
    exec(
        &conn,
        &format!("UPDATE threads SET routed_tab = 'label:{marketing}' WHERE id = 30"),
    );

    for q in [
        "label:\"follow up\" contract",
        "label:follow-up contract",
        "label:follow contract",
        "label:FOLLOWUP",
    ] {
        assert_eq!(ids(&ranked(&conn, q, &[])), vec![10], "{q}");
    }
    assert_eq!(ids(&ranked(&conn, "label:marketing", &[])), vec![30]);
    // Unknown label: nothing, not everything.
    assert!(ranked(&conn, "label:nosuchlabel contract", &[]).is_empty());
    // has:label: any labelled mail.
    assert_eq!(ids(&ranked(&conn, "has:label", &[])), vec![10]);
}

#[test]
fn explain_resolves_labels_and_suggests_for_unknown_ones() {
    let conn = db();
    repo::labels::save(&conn, None, "Follow up", "#f00", 0).unwrap();
    let e = repo::search::explain(&conn, &search::parse("label:follow label:folow-upp x")).unwrap();
    assert_eq!(e.chips.len(), 1);
    assert_eq!(e.chips[0].value, "Follow up", "chip shows the real name");
    assert_eq!(e.warnings.len(), 1);
    assert_eq!(e.warnings[0].kind, "unknown_label");
    assert_eq!(e.warnings[0].suggestion.as_deref(), Some("Follow up"));
}

#[test]
fn date_from_me_read_and_replied_filters() {
    let conn = db();
    let t = now();
    let a = addr("A", "a@x.com");
    insert_message(&conn, 100, 10, "Plan old", &a, t - 40 * DAY);
    insert_message(&conn, 101, 20, "Plan new", &a, t - 2 * DAY);
    exec(
        &conn,
        &format!(
            "INSERT INTO messages (id,account_id,thread_id,folder_id,uid,subject,from_addr,date,is_read,is_outgoing,body_state)
             VALUES (102,1,20,1,102,'Re: Plan new','me@example.com',{},1,1,'cached')",
            t - DAY
        ),
    );
    repo::search::index_message(&conn, 102).unwrap();
    exec(&conn, "UPDATE messages SET is_read = 0 WHERE id = 100");

    assert_eq!(ids(&ranked(&conn, "plan last:7d", &[])), vec![20]);
    assert_eq!(ids(&ranked(&conn, "plan older_than:30d", &[])), vec![10]);
    assert_eq!(ids(&ranked(&conn, "from:me", &[])), vec![20]);
    assert_eq!(ids(&ranked(&conn, "plan is:replied", &[])), vec![20]);
    assert_eq!(ids(&ranked(&conn, "plan is:unread", &[])), vec![10]);
    assert_eq!(ids(&ranked(&conn, "plan is:read", &[])), vec![20]);
}

#[test]
fn filters_also_constrain_semantic_hits() {
    let conn = db();
    let a = addr("A", "a@x.com");
    insert_message(&conn, 100, 10, "alpha", &a, 1_000);
    insert_message(&conn, 101, 20, "beta", &a, 1_000);
    let tag = repo::labels::save(&conn, None, "Work", "#00f", 0).unwrap();
    repo::labels::add_to_message(&conn, 101, tag.id).unwrap();
    let r = ranked(&conn, "zzzunmatched label:work", &[(100, 0.9), (101, 0.88)]);
    assert_eq!(ids(&r), vec![20]);
}

#[test]
fn trash_spam_hidden_and_account_scoped_with_new_filters() {
    let conn = db();
    let a = addr("A", "a@x.com");
    exec(
        &conn,
        "INSERT INTO folders (id,account_id,imap_name,role) VALUES (9,1,'Trash','trash')",
    );
    insert_message(&conn, 100, 10, "Receipt", &a, now() - DAY);
    insert_message(&conn, 101, 20, "Receipt", &a, now() - DAY);
    exec(&conn, "UPDATE messages SET folder_id = 9 WHERE id = 101");
    assert_eq!(ids(&ranked(&conn, "receipt last:7d", &[])), vec![10]);
    assert_eq!(ids(&ranked(&conn, "last:7d", &[])), vec![10]);
    assert_eq!(ids(&ranked(&conn, "in:trash last:7d", &[])), vec![20]);

    let mut q = search::parse("receipt");
    q.account_id = Some(2);
    let lex = repo::search::lexical_candidates(&conn, &q, 50).unwrap();
    let out = repo::search::rank(&conn, &q, lex, &[(100, 0.9)], 50, now()).unwrap();
    assert!(out.threads.is_empty(), "other account sees nothing");
}

#[test]
fn phrase_and_exact_words_beat_scattered_prefix_matches() {
    let conn = db();
    let a = addr("Sales", "sales@x.vn");
    let t = now();
    // Newer, but "giá" only matches as a prefix of "giải" and the words are apart.
    insert_message(&conn, 100, 10, "Báo cáo tiến độ giải pháp", &a, t);
    insert_message(&conn, 101, 20, "Xin báo giá gia công", &a, t - 90 * DAY);
    for q in ["báo giá", "bao gia"] {
        let r = ranked(&conn, q, &[]);
        assert_eq!(ids(&r), vec![20, 10], "{q}");
        assert_eq!(r[0].1, 1, "{q}: the phrase is top tier");
        assert!(
            r[1].1 > 1,
            "{q}: scattered prefix matches rank in a lower tier"
        );
    }
}

#[test]
fn address_only_match_ranks_below_subject_match() {
    let conn = db();
    let t = now();
    insert_message(
        &conn,
        100,
        10,
        "Your receipt",
        &addr("Circle", "invoice+statements@circle.com"),
        t,
    );
    insert_message(
        &conn,
        101,
        20,
        "Invoice March",
        &addr("Vendor", "billing@vendor.com"),
        t,
    );
    assert_eq!(ids(&ranked(&conn, "invoice", &[]))[0], 20);
}
