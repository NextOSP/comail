-- Repair scheduling is separate from deletion intent: no mail is hidden or
-- deleted until the user retries after its remote identity has been verified.
CREATE TABLE trash_identity_recovery (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    retry_at INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL DEFAULT 'pending',
    checked_at INTEGER
);
CREATE INDEX idx_trash_identity_recovery_due
    ON trash_identity_recovery(priority DESC, retry_at, message_id);
