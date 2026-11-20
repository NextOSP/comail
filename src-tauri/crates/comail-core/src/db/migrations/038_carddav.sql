-- Read-only CardDAV contact sync: per-account server config, discovered
-- address books, and the vCards they hold (reduced to what mail needs).
--
-- Card emails feed `contacts` through book_name/book_folded, which only the
-- CardDAV sync writes: a non-NULL book_name means "in an enabled address
-- book" ('' when the card has no name), and it wins over the harvested
-- `name` wherever a contact name is shown. Harvested name and counts are
-- never touched, so a contact deleted on the server falls back to what mail
-- taught us; rows that only existed because of a card (zero counts) go away.

CREATE TABLE carddav_config (
  account_id     INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  base_url       TEXT NOT NULL,
  username       TEXT,               -- password lives in the keyring
  principal_url  TEXT,               -- cached discovery results
  home_set_url   TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_error     TEXT,               -- last cycle's error; NULL = it succeeded
  last_synced_at INTEGER             -- end of the last error-free cycle
);

CREATE TABLE address_books (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,      -- absolute collection href
  display_name   TEXT,
  ctag           TEXT,               -- cheap "anything changed?" gate
  sync_token     TEXT,               -- DAV:sync-token; NULL => full listing
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_synced_at INTEGER,
  UNIQUE(account_id, url)
);

CREATE TABLE contact_cards (
  id              INTEGER PRIMARY KEY,
  address_book_id INTEGER NOT NULL REFERENCES address_books(id) ON DELETE CASCADE,
  href            TEXT NOT NULL,     -- resource path on the server
  etag            TEXT,
  uid             TEXT,
  full_name       TEXT,              -- FN, else N, nickname or organization
  nickname        TEXT,
  org             TEXT,
  title           TEXT,
  phones_json     TEXT NOT NULL DEFAULT '[]',
  UNIQUE(address_book_id, href)
);

CREATE TABLE contact_card_emails (
  card_id  INTEGER NOT NULL REFERENCES contact_cards(id) ON DELETE CASCADE,
  email    TEXT NOT NULL COLLATE NOCASE,  -- lowercased
  kind     TEXT,                          -- TYPE / label: work, home, ...
  pref     INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,
  PRIMARY KEY (card_id, email)
) WITHOUT ROWID;
CREATE INDEX idx_contact_card_emails_email ON contact_card_emails(email);

ALTER TABLE contacts ADD COLUMN book_name TEXT;
ALTER TABLE contacts ADD COLUMN book_folded TEXT;  -- fold(name, nickname) for matching
