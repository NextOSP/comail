-- Unified-inbox ordering: the global thread list sorts by last_message_at
-- without an account filter, which idx_threads_recent(account_id, ...) can't
-- serve.
CREATE INDEX idx_threads_last_msg ON threads(last_message_at DESC);
