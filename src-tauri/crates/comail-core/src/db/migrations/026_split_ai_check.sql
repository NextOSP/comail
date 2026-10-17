-- Optional AI check on a split rule (models::AiCheck, JSON): a yes/no
-- question answered by the decision model. NULL = condition only.
ALTER TABLE split_rules ADD COLUMN ai_json TEXT;
