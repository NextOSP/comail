-- Two-way CalDAV sync: per-account server config, discovered calendar
-- collections, and sync bookkeeping (etag/href/dirty/tombstone) on events.

CREATE TABLE caldav_config (
  account_id    INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('google','generic')),
  base_url      TEXT NOT NULL,
  username      TEXT,               -- generic only; password lives in the keyring
  principal_url TEXT,               -- cached discovery results
  home_set_url  TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_error    TEXT
);

CREATE TABLE calendars (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,     -- absolute collection href
  display_name   TEXT,
  color          TEXT,
  ctag           TEXT,              -- cheap "anything changed?" gate
  sync_token     TEXT,              -- DAV:sync-token; NULL => full-query fallback
  read_only      INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  is_default     INTEGER NOT NULL DEFAULT 0,  -- target for new local events
  last_synced_at INTEGER,
  UNIQUE(account_id, url)
);

ALTER TABLE calendar_events ADD COLUMN calendar_id INTEGER REFERENCES calendars(id) ON DELETE SET NULL;
ALTER TABLE calendar_events ADD COLUMN caldav_href TEXT;  -- resource path on the server
ALTER TABLE calendar_events ADD COLUMN etag        TEXT;
ALTER TABLE calendar_events ADD COLUMN ical_raw    TEXT;  -- full VCALENDAR (round-trip fidelity)
ALTER TABLE calendar_events ADD COLUMN rrule       TEXT;  -- raw RRULE value; NULL = one-off
ALTER TABLE calendar_events ADD COLUMN tzid        TEXT;  -- DTSTART TZID, informational
ALTER TABLE calendar_events ADD COLUMN dirty       INTEGER NOT NULL DEFAULT 0;  -- local change awaiting push
ALTER TABLE calendar_events ADD COLUMN deleted     INTEGER NOT NULL DEFAULT 0;  -- tombstone awaiting DELETE
ALTER TABLE calendar_events ADD COLUMN notified_at INTEGER;  -- occurrence start of last reminder shown

CREATE INDEX idx_events_caldav ON calendar_events(calendar_id, caldav_href);
CREATE INDEX idx_events_dirty  ON calendar_events(dirty, deleted) WHERE dirty = 1 OR deleted = 1;
