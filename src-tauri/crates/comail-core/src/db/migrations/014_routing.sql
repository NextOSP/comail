-- Exclusive routing: every inbox thread resolves to at most one overlay tab so
-- an email lands in exactly one place. `routed_tab` is a route key computed by
-- the resolver (crate::route):
--   'important' | 'other'   forced default bucket (a rule targeting Important/Other)
--   'label:<id>'            an auto-category tab (Marketing/News/Social/Pitch/...)
--   'split:<id>'            a custom split rule that is its own tab
--   'pending'               queued for the async AI classifier; meanwhile shown
--                           in Important/Other like NULL
--   NULL                    unrouted; falls into Important/Other by is_automated
ALTER TABLE threads ADD COLUMN routed_tab TEXT;
CREATE INDEX IF NOT EXISTS idx_threads_routed_tab ON threads(routed_tab);

-- Per-sender cache of AI routing decisions so repeat senders never re-hit the
-- model. route_key mirrors threads.routed_tab; the empty string means "the AI
-- looked and chose no category" (settles into Important/Other). Cleared whenever
-- the category prompt or rules change (see Core::reroute_all).
CREATE TABLE IF NOT EXISTS route_cache (
  sender_domain TEXT PRIMARY KEY,
  route_key     TEXT NOT NULL
);

-- Optional routing target for a split rule. NULL keeps legacy behaviour (the
-- rule is its own tab, key 'split:<id>'); otherwise a route key the matching
-- mail is routed into: 'important' | 'other' | 'label:<id>'.
ALTER TABLE split_rules ADD COLUMN target TEXT;
