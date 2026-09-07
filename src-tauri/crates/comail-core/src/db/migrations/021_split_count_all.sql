-- Per-split badge mode. 0 (the default, and how every tab has always behaved)
-- counts unread conversations; 1 counts every conversation the split holds, so
-- a tab whose mail is all read still shows how much is in it.
ALTER TABLE split_rules ADD COLUMN count_all INTEGER NOT NULL DEFAULT 0;
