-- Diacritic-folded "name email" for accent-insensitive contact matching
-- (e.g. typing "be don dep" matches "Bé Dọn Dẹp"). Populated from Rust -
-- SQLite can't fold Unicode - and backfilled once at startup.
ALTER TABLE contacts ADD COLUMN folded TEXT;
