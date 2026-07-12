-- Unsubscribe: keep the List-Unsubscribe target so Cmd+U can act on it.
ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT;

-- Outgoing attachments staged on a draft before send.
CREATE TABLE draft_attachments (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT
);
CREATE INDEX idx_draft_attachments ON draft_attachments(draft_id);

-- Calendar events parsed from text/calendar MIME parts (invites).
CREATE TABLE calendar_events (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  ical_uid TEXT NOT NULL,
  method TEXT,                       -- REQUEST | CANCEL | REPLY
  summary TEXT,
  location TEXT,
  organizer TEXT,
  starts_at INTEGER NOT NULL,        -- ms epoch (UTC best-effort)
  ends_at INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0,
  status TEXT,                       -- CONFIRMED | CANCELLED | TENTATIVE
  UNIQUE(account_id, ical_uid)
);
CREATE INDEX idx_calendar_starts ON calendar_events(starts_at);
