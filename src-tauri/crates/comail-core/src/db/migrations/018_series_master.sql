-- Microsoft Graph expands a recurring series into per-occurrence rows (see
-- graphcal.rs), each keyed by its own event id in caldav_href; the series
-- master itself is never stored. When a whole series is deleted, Graph's
-- delta feed sends a single @removed item carrying the master's id, which
-- then matches no row. Tracking that id on each occurrence lets deletion
-- match against either the occurrence's own href or its series master.
ALTER TABLE calendar_events ADD COLUMN series_master_id TEXT;
CREATE INDEX idx_events_series_master ON calendar_events(calendar_id, series_master_id);
