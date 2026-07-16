-- Per-account contact affinity. The global `contacts` table stays the canonical
-- identity (email/name/folded) and keeps its global counts for search ranking
-- and sender_known; this table records which accounts have actually corresponded
-- with each contact so compose autocomplete can scope suggestions to the sending
-- account instead of leaking every account's contacts into every composer.
CREATE TABLE contact_accounts (
  contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  send_count      INTEGER NOT NULL DEFAULT 0,
  recv_count      INTEGER NOT NULL DEFAULT 0,
  last_interacted INTEGER,
  PRIMARY KEY (contact_id, account_id)
) WITHOUT ROWID;
CREATE INDEX idx_contact_accounts_acct ON contact_accounts(account_id);

-- Backfill attribution from stored messages: outgoing to/cc recipients count as
-- "sent", incoming senders count as "received", grouped per account. Future
-- harvests keep this current; this one pass seeds existing history so scoped
-- autocomplete is populated immediately after upgrade.
INSERT INTO contact_accounts (contact_id, account_id, send_count, recv_count, last_interacted)
SELECT c.id, x.account_id, SUM(x.sent), SUM(x.recv), MAX(x.when_ms)
FROM (
  SELECT m.account_id AS account_id,
         lower(json_extract(j.value, '$.email')) AS email,
         1 AS sent, 0 AS recv, m.date AS when_ms
  FROM messages m, json_each(m.to_json) j
  WHERE m.is_outgoing = 1 AND json_extract(j.value, '$.email') IS NOT NULL
  UNION ALL
  SELECT m.account_id, lower(json_extract(j.value, '$.email')), 1, 0, m.date
  FROM messages m, json_each(m.cc_json) j
  WHERE m.is_outgoing = 1 AND json_extract(j.value, '$.email') IS NOT NULL
  UNION ALL
  SELECT m.account_id, lower(m.from_addr), 0, 1, m.date
  FROM messages m
  WHERE m.is_outgoing = 0 AND m.from_addr IS NOT NULL AND m.from_addr <> ''
) x
JOIN contacts c ON c.email = x.email COLLATE NOCASE
GROUP BY c.id, x.account_id;
