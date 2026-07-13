-- Robot senders (noreply@, alerts@, mailer-daemon@, Exchange NDRs, ...) are
-- automated even when the message carries no bulk-mail headers. The parser now
-- flags them at sync time; backfill already-stored mail so it moves from the
-- implicit Important split to Other. Prefix list mirrors mime::robot_sender.
UPDATE messages
SET is_automated = 1
WHERE is_automated = 0
  AND is_outgoing = 0
  AND (
       from_addr LIKE 'noreply%'
    OR from_addr LIKE 'no-reply%'
    OR from_addr LIKE 'no\_reply%' ESCAPE '\'
    OR from_addr LIKE 'donotreply%'
    OR from_addr LIKE 'do-not-reply%'
    OR from_addr LIKE 'notification%'
    OR from_addr LIKE 'notify%'
    OR from_addr LIKE 'alert%'
    OR from_addr LIKE 'alarm%'
    OR from_addr LIKE 'mailer-daemon%'
    OR from_addr LIKE 'postmaster%'
    OR from_addr LIKE 'bounce%'
    OR from_addr LIKE 'microsoftexchange%'
  );
