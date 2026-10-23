-- Avoid repeating successful identity FETCHes that returned no stable identity.
CREATE TABLE stable_identity_attempts (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    uid INTEGER NOT NULL,
    uidvalidity INTEGER
);
