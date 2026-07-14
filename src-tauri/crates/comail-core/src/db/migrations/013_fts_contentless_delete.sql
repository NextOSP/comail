-- The original contentless FTS table could only remove a row when supplied
-- with every value that had previously been indexed. Our generic reindex path
-- did not have those historical values, so stale body tokens survived body
-- repairs. SQLite's contentless-delete mode supports ordinary DELETE/replace
-- semantics while retaining the compact contentless index.
DROP TABLE messages_fts;

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_text, to_text, body,
  content='',
  contentless_delete=1,
  tokenize="unicode61 remove_diacritics 2"
);

INSERT INTO messages_fts (rowid, subject, from_text, to_text, body)
SELECT m.id,
       m.subject,
       COALESCE(m.from_name,'') || ' ' || COALESCE(m.from_addr,''),
       m.to_json || ' ' || m.cc_json,
       CASE
         WHEN b.text_body IS NULL
           OR TRIM(b.text_body, char(9) || char(10) || char(11) || char(12) || char(13) || char(32)) = ''
         THEN COALESCE(m.snippet, '')
         ELSE b.text_body
       END
FROM messages m
LEFT JOIN message_bodies b ON b.message_id = m.id;
