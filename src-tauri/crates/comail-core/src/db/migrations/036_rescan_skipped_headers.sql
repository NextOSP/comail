-- 0.2.42 and 0.2.43 sent servers other than Gmail a header FETCH with a
-- doubled space. Outlook answered it with no messages and no error, so sync
-- marked those UIDs as scanned without saving them. Point each folder's scan
-- markers back at the mail actually saved so the next sync fetches what was
-- skipped. A UID that is already saved is not stored twice.

-- New mail: scan again above the newest saved message.
UPDATE folders
SET last_seen_uid = (SELECT MAX(m.uid) FROM messages m WHERE m.folder_id = folders.id)
WHERE account_id IN (SELECT id FROM accounts
                     WHERE provider <> 'gmail'
                       AND lower(imap_host) NOT IN ('imap.gmail.com', 'imap.googlemail.com'))
  AND last_seen_uid > (SELECT MAX(m.uid) FROM messages m WHERE m.folder_id = folders.id);

-- History still being walked: resume it from the oldest saved message.
UPDATE folders
SET backfill_cursor = (SELECT MIN(m.uid) FROM messages m WHERE m.folder_id = folders.id)
WHERE account_id IN (SELECT id FROM accounts
                     WHERE provider <> 'gmail'
                       AND lower(imap_host) NOT IN ('imap.gmail.com', 'imap.googlemail.com'))
  AND backfill_done = 0
  AND backfill_cursor < (SELECT MIN(m.uid) FROM messages m WHERE m.folder_id = folders.id);

-- Nothing saved at all (an account added on 0.2.42 or 0.2.43): sync the folder
-- again from the start.
UPDATE folders
SET last_seen_uid = 0, backfill_cursor = NULL, backfill_done = 0
WHERE account_id IN (SELECT id FROM accounts
                     WHERE provider <> 'gmail'
                       AND lower(imap_host) NOT IN ('imap.gmail.com', 'imap.googlemail.com'))
  AND last_seen_uid > 0
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.folder_id = folders.id AND m.uid IS NOT NULL);
