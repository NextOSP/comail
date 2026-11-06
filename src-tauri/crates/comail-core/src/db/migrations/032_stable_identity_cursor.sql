-- Progress through legacy UIDs even when expunged rows cannot gain a stable ID.
ALTER TABLE folders ADD COLUMN stable_identity_cursor INTEGER;
ALTER TABLE folders ADD COLUMN stable_identity_uidvalidity INTEGER;
