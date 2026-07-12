-- Calendar upgrades: invite details (description/attendees/join link),
-- RSVP state, and locally-created events.
ALTER TABLE calendar_events ADD COLUMN description TEXT;
ALTER TABLE calendar_events ADD COLUMN attendees_json TEXT;
ALTER TABLE calendar_events ADD COLUMN join_url TEXT;
ALTER TABLE calendar_events ADD COLUMN rsvp_status TEXT; -- ACCEPTED | TENTATIVE | DECLINED
ALTER TABLE calendar_events ADD COLUMN is_local INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calendar_events ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
