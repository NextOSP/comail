ALTER TABLE accounts ADD COLUMN imap_security TEXT NOT NULL DEFAULT 'tls'
    CHECK (imap_security IN ('tls', 'starttls'));
ALTER TABLE accounts ADD COLUMN trusted_certificate TEXT;
