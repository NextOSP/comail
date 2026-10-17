-- AI automations (archive, trash, mark read, labels, local annotations) run
-- once per received message. Re-sorting after a rule edit can send a thread
-- back through the AI classifier; this marker stops its actions re-running on
-- mail they already handled. Everything already routed counts as handled.
ALTER TABLE messages ADD COLUMN automations_applied INTEGER NOT NULL DEFAULT 0;
UPDATE messages SET automations_applied = 1
WHERE thread_id IN (SELECT id FROM threads
                    WHERE routed_tab IS NULL OR routed_tab <> 'pending');

-- The AI sender cache used to be keyed by bare domain even for shared
-- providers (gmail.com, qq.com, ...), so one stranger's verdict applied to
-- every sender there. Keys are now per address on those domains; start over.
DELETE FROM route_cache WHERE sender_domain <> '__routing_backfill__';
