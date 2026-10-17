-- Local-only search feedback: one row each time a thread is opened from a
-- search result. Ranking reads it to lift threads, and senders, the user
-- actually picks out of results. Never synced; cleared from Settings.
CREATE TABLE search_events (
  id        INTEGER PRIMARY KEY,
  query     TEXT NOT NULL,          -- folded free-text part of the query
  thread_id INTEGER NOT NULL,
  sender    TEXT NOT NULL DEFAULT '',  -- lowercased from_addr of the thread's latest message
  opened_at INTEGER NOT NULL       -- ms
);
CREATE INDEX idx_search_events_thread ON search_events(thread_id);
CREATE INDEX idx_search_events_sender ON search_events(sender);
