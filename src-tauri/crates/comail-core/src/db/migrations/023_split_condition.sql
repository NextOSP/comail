-- Typed condition tree for split rules (models::RuleCondition, JSON). NULL
-- means the legacy flat query_json is evaluated instead.
ALTER TABLE split_rules ADD COLUMN condition_json TEXT;
