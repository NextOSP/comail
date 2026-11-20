-- A conversation the user filed into an inbox tab by giving it that tab's
-- label (a category such as "Newsletters"), by hand or through a rule's label
-- action. Holds the route key ('label:<id>'); routing honours it before any
-- rule, AI or heuristic so the thread stays where it was put. Cleared when the
-- label comes off the thread or the label is deleted. NULL = routed normally.
ALTER TABLE threads ADD COLUMN tab_override TEXT;
