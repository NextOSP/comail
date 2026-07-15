-- Local presentation annotations produced by AI automations. Received IMAP
-- messages are immutable, so these overlays deliberately never alter the
-- server's RFC 5322 source.
ALTER TABLE messages ADD COLUMN local_subject_prefix TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN local_body_note TEXT NOT NULL DEFAULT '';
