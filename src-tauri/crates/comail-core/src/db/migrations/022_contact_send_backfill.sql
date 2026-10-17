-- Mail sent from comail itself was never harvested: the send path flipped the
-- draft row without recording recipients, and the Sent-folder sync dedupes that
-- row by Message-ID before harvesting. Recount sends from stored outgoing mail
-- (to/cc/bcc) and lift both global and per-account counts to at least that, so
-- people you email often rank first right after upgrade. MAX keeps counts from
-- mail that has since been deleted locally.
CREATE TEMP TABLE sent_recount AS
SELECT x.account_id AS account_id, x.email AS email,
       COUNT(*) AS sends, MAX(x.when_ms) AS last_ms,
       MAX(x.name) AS name
FROM (
  SELECT m.account_id AS account_id,
         lower(json_extract(j.value, '$.email')) AS email,
         NULLIF(json_extract(j.value, '$.name'), '') AS name,
         m.date AS when_ms
  FROM messages m, json_each(m.to_json) j
  WHERE m.is_outgoing = 1 AND m.is_draft = 0
  UNION ALL
  SELECT m.account_id, lower(json_extract(j.value, '$.email')),
         NULLIF(json_extract(j.value, '$.name'), ''), m.date
  FROM messages m, json_each(m.cc_json) j
  WHERE m.is_outgoing = 1 AND m.is_draft = 0
  UNION ALL
  SELECT m.account_id, lower(json_extract(j.value, '$.email')),
         NULLIF(json_extract(j.value, '$.name'), ''), m.date
  FROM messages m, json_each(m.bcc_json) j
  WHERE m.is_outgoing = 1 AND m.is_draft = 0
) x
WHERE x.email LIKE '%@%'
GROUP BY x.account_id, x.email;

-- Recipients never harvested at all. `folded` is left NULL; the startup
-- backfill_folded pass fills it in.
INSERT OR IGNORE INTO contacts (email, name, send_count, recv_count, last_interacted)
SELECT email, MAX(name), 0, 0, MAX(last_ms) FROM sent_recount GROUP BY email;

UPDATE contacts SET
  send_count = MAX(send_count, t.sends),
  last_interacted = MAX(COALESCE(last_interacted, 0), COALESCE(t.last_ms, 0))
FROM (SELECT email, SUM(sends) AS sends, MAX(last_ms) AS last_ms
      FROM sent_recount GROUP BY email) t
WHERE contacts.email = t.email;

INSERT INTO contact_accounts (contact_id, account_id, send_count, recv_count, last_interacted)
SELECT c.id, r.account_id, r.sends, 0, r.last_ms
FROM sent_recount r JOIN contacts c ON c.email = r.email
WHERE true
ON CONFLICT(contact_id, account_id) DO UPDATE SET
  send_count = MAX(contact_accounts.send_count, excluded.send_count),
  last_interacted = MAX(COALESCE(contact_accounts.last_interacted, 0),
                        COALESCE(excluded.last_interacted, 0));

DROP TABLE sent_recount;
