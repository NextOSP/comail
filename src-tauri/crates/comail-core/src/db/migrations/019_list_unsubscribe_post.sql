-- RFC 8058 One-Click: persist List-Unsubscribe-Post alongside List-Unsubscribe.
ALTER TABLE messages ADD COLUMN list_unsubscribe_post TEXT;
