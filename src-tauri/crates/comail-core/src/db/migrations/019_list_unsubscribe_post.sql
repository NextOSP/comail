-- RFC 8058 one-click unsubscribe: a "List-Unsubscribe-Post: List-Unsubscribe=One-Click"
-- header marks the HTTPS URI in List-Unsubscribe as safe to POST to without a
-- browser round-trip. Stored raw alongside list_unsubscribe so the unsubscribe
-- command can pick the right mechanism offline-cheap, without refetching headers.
ALTER TABLE messages ADD COLUMN list_unsubscribe_post TEXT;
