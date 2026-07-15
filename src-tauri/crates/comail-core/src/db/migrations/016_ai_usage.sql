-- One compact row per successful AI completion. This powers the local usage
-- dashboard and never includes prompt or response content.
CREATE TABLE ai_usage_events (
  id                INTEGER PRIMARY KEY,
  occurred_at       INTEGER NOT NULL,
  model             TEXT NOT NULL,
  scenario          TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  exact             INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_ai_usage_occurred ON ai_usage_events(occurred_at);
