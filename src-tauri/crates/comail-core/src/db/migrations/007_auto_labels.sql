-- Auto Labels: system categories (Marketing / News / Social / Pitch) reuse the
-- labels table, flagged is_auto. They are classified locally at sync time and
-- never pushed to IMAP (see labels::reconcile_keywords guard).
ALTER TABLE labels ADD COLUMN is_auto INTEGER NOT NULL DEFAULT 0;

-- INSERT OR IGNORE: labels.name is UNIQUE and a user label may collide; the
-- classifier resolves rows by keyword, not name.
INSERT OR IGNORE INTO labels (name, color, keyword, position, is_auto) VALUES
  ('Marketing', '#e0708a', 'ComailAutoMarketing', 1000, 1),
  ('News',      '#5b9dd9', 'ComailAutoNews',      1001, 1),
  ('Social',    '#7bc47f', 'ComailAutoSocial',    1002, 1),
  ('Pitch',     '#c9a04e', 'ComailAutoPitch',     1003, 1);

-- Exact unread counts touch only unread threads; keep that path indexed.
CREATE INDEX IF NOT EXISTS idx_threads_unread ON threads(account_id) WHERE unread_count > 0;
