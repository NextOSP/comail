-- User-defined labels (Gmail-style tags), applied per message and aggregated
-- to the thread level in the UI. `keyword` is the IMAP keyword atom pushed to
-- the server so labels round-trip across clients.
CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6b7280',
  keyword TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE(name)
);

CREATE TABLE message_labels (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, label_id)
);
CREATE INDEX idx_message_labels_label ON message_labels(label_id, message_id);
