-- Keep remote-identity tombstones after the original message row is removed.
-- CASE guards every JSON expression, including index maintenance on bad payloads.
CREATE INDEX idx_actions_permanent_delete_identity ON pending_actions (
    (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.accountId') END),
    (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.folderId') END),
    (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.uid') END),
    (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.uidValidity') END)
) WHERE kind = 'delete_permanently' AND state IN ('pending', 'inflight', 'done');

-- Bound same-message predecessor checks without scanning an account's queue.
CREATE INDEX idx_actions_active_predecessor ON pending_actions (account_id, message_id, id)
WHERE state IN ('pending', 'inflight') AND kind NOT LIKE 'cal!_%' ESCAPE '!';

-- Unary + removes column affinity so SQLite can seek the JSON expression index
-- (and string-valued JSON identifiers cannot masquerade as integer identities).
CREATE VIEW visible_messages AS
SELECT m.* FROM messages m
WHERE NOT EXISTS (
    SELECT 1 FROM pending_actions p
    WHERE p.kind = 'delete_permanently' AND p.state IN ('pending', 'inflight', 'done')
      AND (CASE WHEN json_valid(p.payload) THEN json_extract(p.payload, '$.accountId') END) = +m.account_id
      AND (CASE WHEN json_valid(p.payload) THEN json_extract(p.payload, '$.folderId') END) = +m.folder_id
      AND (CASE WHEN json_valid(p.payload) THEN json_extract(p.payload, '$.uid') END) = +m.uid
      AND (CASE WHEN json_valid(p.payload) THEN json_extract(p.payload, '$.uidValidity') END) = +
          (SELECT f.uidvalidity FROM folders f WHERE f.id = m.folder_id AND f.account_id = m.account_id)
      AND p.account_id = m.account_id
);
