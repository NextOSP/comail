DROP TABLE IF EXISTS trash_identity_recovery;
DROP INDEX IF EXISTS idx_actions_permanent_delete_identity;
CREATE INDEX idx_actions_delete_message ON pending_actions (account_id, message_id)
WHERE kind='delete_permanently' AND state IN ('pending','inflight');
DROP VIEW visible_messages;
CREATE VIEW visible_messages AS
SELECT m.* FROM messages m
WHERE NOT EXISTS (
    SELECT 1 FROM pending_actions p
    WHERE p.kind = 'delete_permanently' AND p.state IN ('pending', 'inflight')
      AND p.account_id = m.account_id AND p.message_id = m.id
);
