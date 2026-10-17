-- Automations now run on all newly received mail, not only mail the AI
-- classifier sorts. Mail that arrived before this change counts as handled.
UPDATE messages SET automations_applied = 1 WHERE automations_applied = 0;
