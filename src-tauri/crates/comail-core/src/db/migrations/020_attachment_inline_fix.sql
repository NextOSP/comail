-- Repair attachments that were stored as "inline" only because the part
-- carried a Content-ID. Gmail and Exchange stamp a Content-ID on ordinary
-- file attachments too, so real files (PDFs, docx, images sent as files) were
-- hidden from the list paperclip and the message-card footer.
--
-- Two conservative rules, both recoverable from what is already on disk:
--   1. A non-image part is never rendered from a cid: reference.
--   2. For messages whose body is cached, a Content-ID that the HTML never
--      references cannot be an embedded image.

UPDATE attachments
SET is_inline = 0
WHERE is_inline = 1
  AND (mime_type IS NULL OR mime_type NOT LIKE 'image/%');

UPDATE attachments
SET is_inline = 0
WHERE is_inline = 1
  AND content_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM message_bodies b
    WHERE b.message_id = attachments.message_id
      AND b.html_body IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM message_bodies b
    WHERE b.message_id = attachments.message_id
      AND b.html_body LIKE '%cid:' || attachments.content_id || '%'
  );

-- Only ever turn the flag on: has_attachments is also set from BODYSTRUCTURE
-- before any attachment rows exist, and that signal must survive.
UPDATE messages
SET has_attachments = 1
WHERE has_attachments = 0
  AND EXISTS (
    SELECT 1 FROM attachments a
    WHERE a.message_id = messages.id AND a.is_inline = 0
  );

UPDATE threads
SET attachment_count = (
  SELECT COUNT(*) FROM messages m
  WHERE m.thread_id = threads.id AND m.has_attachments = 1
);
