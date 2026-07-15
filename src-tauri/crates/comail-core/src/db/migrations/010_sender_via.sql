-- The party that actually transmitted the message when its domain does not
-- align with From: (Sender: / Return-Path / DKIM d= - see mime::resolve_via).
-- Shown as "via" in the message-details popover; catches mailing lists, ESPs
-- and spoofed From: addresses. NULL for aligned mail and for mail synced
-- before this migration.
ALTER TABLE messages ADD COLUMN sender_addr TEXT;
