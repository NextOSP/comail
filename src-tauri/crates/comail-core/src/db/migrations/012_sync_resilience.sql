-- Resumable MIME/content sync. The plan is versioned JSON so newer parsers can
-- ignore/rebuild old plans without changing the relational schema.
ALTER TABLE messages ADD COLUMN mime_plan_json TEXT;

-- The IMAP BODYSTRUCTURE section (for example "2.1") is distinct from the
-- legacy raw-MIME part_id. Existing attachment rows and cached file paths are
-- deliberately left untouched.
ALTER TABLE attachments ADD COLUMN imap_section TEXT;
CREATE UNIQUE INDEX idx_attachments_imap_section
  ON attachments(message_id, imap_section)
  WHERE imap_section IS NOT NULL;

-- A single durable retry ledger covers failures that happen before a message
-- row exists (header parsing/fetch) and failures tied to an existing message
-- (content fetch/decode). Partial unique indexes make retries idempotent.
CREATE TABLE sync_failures (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('header','content')),
  folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  uid INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1,
  next_retry_at INTEGER,
  last_error TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (stage = 'header' AND folder_id IS NOT NULL AND uid IS NOT NULL AND message_id IS NULL)
    OR
    (stage = 'content' AND folder_id IS NULL AND uid IS NULL AND message_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_sync_failures_header
  ON sync_failures(folder_id, uid)
  WHERE stage = 'header';
CREATE UNIQUE INDEX idx_sync_failures_content
  ON sync_failures(message_id)
  WHERE stage = 'content';
CREATE INDEX idx_sync_failures_due
  ON sync_failures(account_id, stage, next_retry_at, updated_at);

-- Native notifications are dispatched outside the webview. Snapshotting the
-- presentation fields lets the dispatcher work without hydrating a thread.
-- message_id is unique so replaying a sync transaction cannot enqueue a second
-- banner for the same message.
CREATE TABLE notification_outbox (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  thread_id INTEGER REFERENCES threads(id) ON DELETE SET NULL,
  sender_name TEXT,
  sender_addr TEXT,
  subject TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','delivering','delivered','suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  delivered_at INTEGER,
  suppressed_at INTEGER,
  suppression_reason TEXT,
  last_error TEXT
);
CREATE INDEX idx_notification_outbox_due
  ON notification_outbox(state, not_before, created_at);
