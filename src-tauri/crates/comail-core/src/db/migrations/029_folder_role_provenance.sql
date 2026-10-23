-- Cached roles did not record whether they came from LIST attributes or names.
-- Do not invent SPECIAL-USE evidence for legacy rows, even Gmail-native ones.
ALTER TABLE folders ADD COLUMN role_source TEXT NOT NULL DEFAULT 'legacy'
    CHECK (role_source IN ('legacy', 'inbox', 'special_use', 'gmail_name', 'name'));
UPDATE folders SET role_source = 'inbox'
WHERE role = 'inbox' AND imap_name = 'INBOX' COLLATE NOCASE;
CREATE INDEX idx_folders_role_source ON folders(account_id, role, role_source);
