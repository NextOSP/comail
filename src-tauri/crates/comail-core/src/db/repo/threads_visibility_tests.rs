use super::*;
use crate::db::{
    migrations,
    repo::{counts, email_stats, labels, messages, search},
    testutil,
};

fn setup(c: &Connection) {
    c.pragma_update(None, "foreign_keys", "ON").unwrap();
    testutil::seed_account(c);
    c.execute_batch(
        "UPDATE folders SET uidvalidity=42;
        INSERT INTO folders(id,account_id,imap_name,role,uidvalidity) VALUES
        (2,1,'Trash','trash',42),(3,1,'Sent','sent',42),(4,1,'Spam','spam',42);",
    )
    .unwrap();
}

fn tombstone(c: &Connection, mid: i64, state: &str) -> i64 {
    c.execute(
        "INSERT INTO pending_actions(account_id,kind,message_id,thread_id,payload,state,created_at)
         SELECT m.account_id,'delete_permanently',m.id,m.thread_id,
           json_object('accountId',m.account_id,'folderId',m.folder_id,'uid',m.uid,
                       'uidValidity',f.uidvalidity,'messageId',m.id,'threadId',m.thread_id),?2,0
         FROM messages m JOIN folders f ON f.id=m.folder_id WHERE m.id=?1",
        params![mid, state],
    )
    .unwrap();
    c.last_insert_rowid()
}

fn listed(c: &Connection, view: View, folder_id: Option<i64>, limit: i64) -> Vec<i64> {
    list(
        c,
        &ListArgs {
            view,
            folder_id,
            tab: None,
            account_id: None,
            cursor: None,
            limit,
        },
    )
    .unwrap()
    .threads
    .into_iter()
    .map(|t| t.id)
    .collect()
}

fn assert_hidden(c: &Connection, tid: i64, mid: i64) {
    assert!(get_summary(c, tid).unwrap().is_none());
    assert!(get_summaries(c, &[tid]).unwrap().is_empty());
    assert!(messages::list_for_thread(c, tid).unwrap().is_empty());
    assert!(messages::detail(c, mid).is_err());
    assert!(
        messages::get_row(c, mid).unwrap().is_some(),
        "physical maintenance read survives"
    );
    assert!(listed(c, View::All, Some(2), 1).is_empty());
    assert!(listed(c, View::Trash, None, 1).is_empty());
    let q = crate::search::parse("in:trash tombstoneword");
    assert!(search::lexical_thread_ids(c, &q, 10).unwrap().is_empty());
    assert!(
        search::message_hits(c, &q, &[(mid, 0.99)], 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn permanent_delete_visibility_filters_labels_and_stats_until_failure() {
    let c = testutil::conn();
    setup(&c);
    let hidden_label = labels::save(&c, None, "Hidden", "#fff", 0).unwrap().id;
    let shared_label = labels::save(&c, None, "Shared", "#fff", 1).unwrap().id;
    let (tid, hidden_in) = testutil::seed_message(&c, "hidden@test.dev", "hidden", false);
    let (_, hidden_out) = testutil::seed_message(&c, "me@test.dev", "hidden sent", false);
    let (_, live_in) = testutil::seed_message(&c, "live@test.dev", "live", false);
    let (_, live_out) = testutil::seed_message(&c, "me@test.dev", "live sent", false);
    c.execute(
        "UPDATE messages SET thread_id=?1,date=CAST(strftime('%s','now') AS INTEGER)*1000",
        [tid],
    )
    .unwrap();
    c.execute(
        "UPDATE messages SET folder_id=2 WHERE id IN (?1,?2)",
        params![hidden_in, hidden_out],
    )
    .unwrap();
    c.execute(
        "UPDATE messages SET is_outgoing=1 WHERE id IN (?1,?2)",
        params![hidden_out, live_out],
    )
    .unwrap();
    labels::add_to_message(&c, hidden_in, hidden_label).unwrap();
    labels::add_to_message(&c, hidden_out, hidden_label).unwrap();
    labels::add_to_message(&c, hidden_in, shared_label).unwrap();
    labels::add_to_message(&c, live_in, shared_label).unwrap();
    let assert_stats = |n| {
        let s = email_stats::stats(&c).unwrap();
        assert_eq!(
            [
                s.total_sent,
                s.total_received,
                s.today_sent,
                s.today_received,
                s.last_7_days_sent,
                s.last_7_days_received,
                s.last_30_days_sent,
                s.last_30_days_received
            ],
            [n; 8]
        );
        assert_eq!(s.days.len(), 1);
        assert_eq!((s.days[0].sent, s.days[0].received), (n, n));
    };
    assert_stats(2);
    assert_eq!(
        labels::for_thread(&c, tid).unwrap(),
        vec![hidden_label, shared_label]
    );
    let incoming_action = tombstone(&c, hidden_in, "pending");
    let outgoing_action = tombstone(&c, hidden_out, "pending");
    for state in ["pending", "inflight", "failed"] {
        c.execute(
            "UPDATE pending_actions SET state=?3 WHERE id IN (?1,?2)",
            params![incoming_action, outgoing_action, state],
        )
        .unwrap();
        let expected_labels = if state == "failed" {
            vec![hidden_label, shared_label]
        } else {
            vec![shared_label]
        };
        assert_eq!(
            labels::for_thread(&c, tid).unwrap(),
            expected_labels,
            "state={state}"
        );
        assert_stats(if state == "failed" { 2 } else { 1 });
        assert!(messages::get_row(&c, hidden_in).unwrap().is_some());
        assert!(messages::get_row(&c, hidden_out).unwrap().is_some());
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM message_labels WHERE label_id=?1",
                [hidden_label],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
    }
}

#[test]
fn permanent_delete_visibility_predecessor_queries_seek_partial_index() {
    let c = testutil::conn();
    setup(&c);
    // Match the correlated predecessor predicates in actions::due/try_claim.
    for sql in [
        "EXPLAIN QUERY PLAN SELECT * FROM pending_actions
         WHERE account_id=1 AND state='pending' AND (not_before IS NULL OR not_before<=1000)
           AND kind NOT LIKE 'cal!_%' ESCAPE '!'
           AND NOT EXISTS (
               SELECT 1 FROM pending_actions predecessor
               WHERE predecessor.account_id=pending_actions.account_id
                 AND predecessor.message_id=pending_actions.message_id
                 AND predecessor.id<pending_actions.id
                 AND predecessor.state IN ('pending','inflight')
                 AND predecessor.kind NOT LIKE 'cal!_%' ESCAPE '!')
         ORDER BY created_at ASC,id ASC LIMIT 50",
        "EXPLAIN QUERY PLAN UPDATE pending_actions SET state='inflight'
         WHERE id=1 AND state='pending' AND NOT EXISTS (
             SELECT 1 FROM pending_actions predecessor
             WHERE predecessor.account_id=pending_actions.account_id
               AND predecessor.message_id=pending_actions.message_id
               AND predecessor.id<pending_actions.id
               AND predecessor.state IN ('pending','inflight')
               AND predecessor.kind NOT LIKE 'cal!_%' ESCAPE '!')",
    ] {
        let plan = c
            .prepare(sql)
            .unwrap()
            .query_map([], |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(
            plan.iter().any(|step| step
                .contains("SEARCH predecessor USING INDEX idx_actions_active_predecessor")
                && step.contains("account_id=? AND message_id=? AND id<?")),
            "{plan:?}"
        );
    }
}

#[test]
fn permanent_delete_visibility_hides_uidless_rows_by_durable_action_link() {
    let c = testutil::conn();
    setup(&c);
    let (tid, mid) = testutil::seed_message(&c, "visible@test.dev", "visible", false);
    for payload in ["{", "null", "[]", "{}"] {
        c.execute("INSERT INTO pending_actions(account_id,kind,payload,created_at) VALUES (1,'delete_permanently',?1,0)", [payload]).unwrap();
    }
    assert_eq!(messages::list_for_thread(&c, tid).unwrap().len(), 1);
    tombstone(&c, mid, "pending");
    c.execute("UPDATE messages SET uid=NULL WHERE id=?1", [mid])
        .unwrap();
    c.execute("UPDATE folders SET uidvalidity=NULL WHERE id=1", [])
        .unwrap();
    assert!(messages::list_for_thread(&c, tid).unwrap().is_empty());
    let plan = c
        .prepare("EXPLAIN QUERY PLAN SELECT * FROM visible_messages WHERE thread_id=?1")
        .unwrap()
        .query_map([tid], |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(
        plan.iter()
            .any(|step| step.contains("idx_actions_delete_message")),
        "{plan:?}"
    );
}

#[test]
fn permanent_delete_visibility_filters_counts_and_semantic_ranking() {
    let c = testutil::conn();
    setup(&c);
    let (hidden_tid, hidden) = testutil::seed_message(&c, "hidden@test.dev", "hidden", false);
    let (live_tid, live) = testutil::seed_message(&c, "live@test.dev", "live", false);
    c.execute("UPDATE messages SET folder_id=4 WHERE id=?1", [hidden])
        .unwrap();
    recompute(&c, hidden_tid).unwrap();
    recompute(&c, live_tid).unwrap();
    assert_eq!(
        counts::unread_counts(&c, None, &[], &[]).unwrap().views["spam"],
        1
    );
    let aid = tombstone(&c, hidden, "pending");
    recompute(&c, hidden_tid).unwrap();
    assert_eq!(
        counts::unread_counts(&c, None, &[], &[]).unwrap().views["spam"],
        0
    );
    c.execute(
        "UPDATE pending_actions SET state='failed' WHERE id=?1",
        [aid],
    )
    .unwrap();
    recompute(&c, hidden_tid).unwrap();
    assert_eq!(
        counts::unread_counts(&c, None, &[], &[]).unwrap().views["spam"],
        1
    );
    // Put both in one scope to test semantic visibility rather than folder exclusion.
    c.execute("UPDATE messages SET folder_id=1 WHERE id=?1", [hidden])
        .unwrap();
    tombstone(&c, hidden, "pending");
    recompute(&c, hidden_tid).unwrap();
    let badge = counts::unread_counts(&c, None, &[], &[]).unwrap();
    assert_eq!((badge.inbox, badge.important), (1, 1));
    let q = crate::search::parse("unmatchedword");
    let hits = search::rank(
        &c,
        &q,
        search::Lexical::default(),
        &[(hidden, 0.99), (live, 0.80)],
        1,
        2000,
    )
    .unwrap();
    assert_eq!(
        hits.threads.iter().map(|t| t.id).collect::<Vec<_>>(),
        vec![live_tid]
    );
    assert_eq!(
        search::message_hits(&c, &q, &[(hidden, 0.99), (live, 0.80)], 1).unwrap(),
        vec![live]
    );
}

#[test]
fn permanent_delete_visibility_filters_before_list_and_fts_limits() {
    let c = testutil::conn();
    setup(&c);
    c.execute_batch("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2001)
        INSERT INTO threads(id,account_id,subject_norm,last_message_at) SELECT x,1,'tombstoneword',9000+x FROM n;
        INSERT INTO messages(id,account_id,thread_id,folder_id,uid,subject,date)
        SELECT id,1,id,2,id,'tombstoneword',9000+id FROM threads;
        INSERT INTO messages_fts(rowid,subject,from_text,to_text,body)
        SELECT id,subject,'','','' FROM messages;
        INSERT INTO pending_actions(account_id,kind,message_id,thread_id,payload,created_at)
        SELECT 1,'delete_permanently',id,thread_id,
            json_object('accountId',1,'folderId',2,'uid',uid,'uidValidity',42,'messageId',id,'threadId',thread_id),0
        FROM messages;").unwrap();
    let (live_tid, live) = testutil::seed_message(
        &c,
        "live@test.dev",
        "tombstoneword other filler terms",
        false,
    );
    c.execute("UPDATE messages SET folder_id=2 WHERE id=?1", [live])
        .unwrap();
    recompute(&c, live_tid).unwrap();
    search::index_message(&c, live).unwrap();
    assert_eq!(listed(&c, View::Trash, None, 1), vec![live_tid]);
    assert_eq!(listed(&c, View::All, Some(2), 1), vec![live_tid]);
    let q = crate::search::parse("in:trash tombstoneword");
    assert_eq!(
        search::lexical_thread_ids(&c, &q, 1).unwrap(),
        vec![live_tid]
    );
    assert_eq!(search::message_hits(&c, &q, &[], 1).unwrap(), vec![live]);
}

#[test]
fn permanent_delete_visibility_survives_restart_and_terminal_states() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("visibility.sqlite");
    let mut c = Connection::open(&path).unwrap();
    migrations::run(&mut c).unwrap();
    setup(&c);
    let (tid, mid) = testutil::seed_message(&c, "hidden@test.dev", "tombstoneword", false);
    c.execute(
        "UPDATE messages SET folder_id=2,raw_path='/cache/keep.eml' WHERE id=?1",
        [mid],
    )
    .unwrap();
    search::index_message(&c, mid).unwrap();
    recompute(&c, tid).unwrap();
    let aid = tombstone(&c, mid, "pending");
    recompute(&c, tid).unwrap();
    assert_hidden(&c, tid, mid);
    let stored: (i64, i64, String) = c.query_row(
        "SELECT t.message_count,t.last_message_at,m.raw_path FROM threads t JOIN messages m ON m.thread_id=t.id WHERE t.id=?1",
        [tid], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(stored, (0, 0, "/cache/keep.eml".into()));
    c.execute(
        "UPDATE pending_actions SET state='inflight' WHERE id=?1",
        [aid],
    )
    .unwrap();
    assert_hidden(&c, tid, mid);
    drop(c);
    let mut c = Connection::open(&path).unwrap();
    c.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrations::run(&mut c).unwrap();
    assert_hidden(&c, tid, mid);
    c.execute(
        "UPDATE pending_actions SET state='pending' WHERE state='inflight'",
        [],
    )
    .unwrap();
    assert_hidden(&c, tid, mid);
    for state in ["done", "failed", "cancelled"] {
        c.execute(
            "UPDATE pending_actions SET state=?2 WHERE id=?1",
            params![aid, state],
        )
        .unwrap();
        recompute(&c, tid).unwrap();
        assert_eq!(get_summary(&c, tid).unwrap().unwrap().message_count, 1);
        assert_eq!(messages::list_for_thread(&c, tid).unwrap().len(), 1);
        assert_eq!(listed(&c, View::Trash, None, 1), vec![tid]);
        assert_eq!(
            search::lexical_thread_ids(&c, &crate::search::parse("in:trash tombstoneword"), 10)
                .unwrap(),
            vec![tid]
        );
    }
}

#[test]
fn completed_action_does_not_hide_a_replacement_row() {
    let c = testutil::conn();
    setup(&c);
    let (tid, mid) = testutil::seed_message(&c, "hidden@test.dev", "tombstoneword", false);
    let aid = tombstone(&c, mid, "pending");
    messages::delete(&c, mid).unwrap();
    assert!(
        c.query_row(
            "SELECT message_id IS NULL FROM pending_actions WHERE id=?1",
            [aid],
            |r| r.get::<_, bool>(0)
        )
        .unwrap()
    );
    c.execute("INSERT INTO messages(id,account_id,thread_id,folder_id,uid,subject,date) VALUES (999,1,?1,2,?1,'replacement',1000)", [tid]).unwrap();
    recompute(&c, tid).unwrap();
    assert_eq!(messages::list_for_thread(&c, tid).unwrap().len(), 1);
    c.execute("UPDATE pending_actions SET state='done' WHERE id=?1", [aid])
        .unwrap();
    assert_eq!(messages::list_for_thread(&c, tid).unwrap().len(), 1);
}

#[test]
fn permanent_delete_visibility_keeps_mixed_inbox_sent_and_visible_aggregates() {
    let c = testutil::conn();
    setup(&c);
    let (tid, hidden) = testutil::seed_message(&c, "hidden@test.dev", "hiddenword", true);
    c.execute("UPDATE messages SET folder_id=2,date=9000,snippet='hidden',is_starred=1,has_attachments=1 WHERE id=?1", [hidden]).unwrap();
    let (_, inbox) = testutil::seed_message(&c, "live@test.dev", "liveword", false);
    c.execute(
        "UPDATE messages SET thread_id=?1,date=2000,snippet='live',is_read=1 WHERE id=?2",
        params![tid, inbox],
    )
    .unwrap();
    let (_, sent) = testutil::seed_message(&c, "me@test.dev", "sentword", false);
    c.execute("UPDATE messages SET thread_id=?1,folder_id=3,date=1000,is_read=1,is_outgoing=1 WHERE id=?2", params![tid,sent]).unwrap();
    c.execute_batch(
        "INSERT INTO labels(id,name,color,keyword,position) VALUES (99,'Hidden','#fff','Hidden',0);",
    )
    .unwrap();
    c.execute(
        "INSERT INTO message_labels(message_id,label_id) VALUES (?1,99)",
        [hidden],
    )
    .unwrap();
    tombstone(&c, hidden, "pending");
    recompute(&c, tid).unwrap();
    let s = get_summary(&c, tid).unwrap().unwrap();
    assert_eq!(
        (s.message_count, s.unread_count, s.last_message_at),
        (2, 0, 2000)
    );
    assert_eq!(
        (s.subject.as_str(), s.snippet.as_str()),
        ("liveword", "live")
    );
    assert!(!s.is_starred && !s.has_attachments && s.labels.is_empty());
    assert!(s.participants.iter().all(|a| a.email != "hidden@test.dev"));
    for view in [View::Inbox, View::Sent, View::All] {
        assert_eq!(listed(&c, view, None, 1), vec![tid]);
    }
    assert!(listed(&c, View::Trash, None, 1).is_empty());
    assert!(listed(&c, View::All, Some(2), 1).is_empty());
    assert_eq!(
        messages::list_for_thread(&c, tid)
            .unwrap()
            .iter()
            .map(|m| m.id)
            .collect::<Vec<_>>(),
        vec![sent, inbox]
    );
    let badge = counts::unread_counts(&c, None, &[], &[]).unwrap();
    assert_eq!((badge.inbox, badge.views["starred"]), (0, 0));
    search::index_message(&c, hidden).unwrap();
    assert!(
        search::lexical_thread_ids(&c, &crate::search::parse("in:trash hiddenword"), 10)
            .unwrap()
            .is_empty()
    );
    assert!(
        search::message_hits(&c, &crate::search::parse("in:trash"), &[(hidden, 0.99)], 10)
            .unwrap()
            .is_empty()
    );
}
