CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('imap','gmail','microsoft')),
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('password','oauth2')),
  username TEXT NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  sync_state TEXT NOT NULL DEFAULT 'idle',
  created_at INTEGER NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE folders (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  imap_name TEXT NOT NULL,
  delimiter TEXT,
  role TEXT,  -- inbox|archive|sent|drafts|trash|spam|all|snoozed
  uidvalidity INTEGER,
  uidnext INTEGER,
  highestmodseq INTEGER,
  last_seen_uid INTEGER NOT NULL DEFAULT 0,
  backfill_cursor INTEGER,          -- lowest UID whose headers are stored; NULL = backfill not started
  backfill_done INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id, imap_name)
);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  gm_thrid TEXT,
  subject_norm TEXT,
  last_message_at INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  starred_count INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  snippet TEXT NOT NULL DEFAULT '',
  participants_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_threads_recent ON threads(account_id, last_message_at DESC);
CREATE INDEX idx_threads_gm ON threads(account_id, gm_thrid);
CREATE INDEX idx_threads_subj ON threads(account_id, subject_norm);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id INTEGER REFERENCES threads(id),
  folder_id INTEGER REFERENCES folders(id),
  uid INTEGER,                       -- NULL for local-only (drafts/outbox)
  message_id TEXT,                   -- RFC 5322 Message-ID
  gm_msgid TEXT,
  gm_thrid TEXT,
  subject TEXT NOT NULL DEFAULT '',
  from_name TEXT,
  from_addr TEXT,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  date INTEGER NOT NULL,             -- ms epoch, from Date header (fallback INTERNALDATE)
  internal_date INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  is_draft INTEGER NOT NULL DEFAULT 0,
  is_outgoing INTEGER NOT NULL DEFAULT 0,
  is_automated INTEGER NOT NULL DEFAULT 0,  -- List-Id/Precedence:bulk heuristics, set at header sync
  has_attachments INTEGER NOT NULL DEFAULT 0,
  size INTEGER,
  snippet TEXT NOT NULL DEFAULT '',
  body_state TEXT NOT NULL DEFAULT 'none' CHECK (body_state IN ('none','fetching','cached')),
  raw_path TEXT,
  UNIQUE(account_id, folder_id, uid)
);
CREATE INDEX idx_messages_thread ON messages(thread_id, date);
CREATE INDEX idx_messages_msgid ON messages(account_id, message_id);
CREATE INDEX idx_messages_folder_uid ON messages(folder_id, uid);
CREATE INDEX idx_messages_gm_msgid ON messages(account_id, gm_msgid);

CREATE TABLE message_bodies (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  text_body TEXT,
  html_body TEXT                    -- sanitized
);

CREATE TABLE message_refs (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ref_message_id TEXT NOT NULL,
  PRIMARY KEY (message_id, ref_message_id)
) WITHOUT ROWID;
CREATE INDEX idx_refs_lookup ON message_refs(ref_message_id);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part_id TEXT,                     -- MIME part index within the raw message
  filename TEXT,
  mime_type TEXT,
  size INTEGER,
  content_id TEXT,
  is_inline INTEGER NOT NULL DEFAULT 0,
  file_path TEXT
);
CREATE INDEX idx_attachments_msg ON attachments(message_id);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  send_count INTEGER NOT NULL DEFAULT 0,
  recv_count INTEGER NOT NULL DEFAULT 0,
  last_interacted INTEGER
);
CREATE INDEX idx_contacts_rank ON contacts(send_count DESC, last_interacted DESC);

CREATE TABLE pending_actions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  thread_id INTEGER,
  payload TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','inflight','done','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  last_error TEXT
);
CREATE INDEX idx_actions_due ON pending_actions(account_id, state, not_before, created_at);

CREATE TABLE snoozes (
  thread_id INTEGER PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL,
  wake_at INTEGER NOT NULL,
  orig_folder_id INTEGER
);
CREATE INDEX idx_snoozes_wake ON snoozes(wake_at);

CREATE TABLE snippets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  shortcut TEXT UNIQUE,
  subject TEXT,
  body_text TEXT NOT NULL DEFAULT '',
  usage_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE split_rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  query_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE drafts_meta (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'new',           -- new|reply|reply_all|forward
  in_reply_to_message_id INTEGER,             -- local message PK being replied to
  remote_uid INTEGER                          -- UID in Drafts folder if APPENDed
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Contentless FTS5; rowid == messages.id, indexed explicitly at write time.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_text, to_text, body,
  content='',
  tokenize="unicode61 remove_diacritics 2"
);
