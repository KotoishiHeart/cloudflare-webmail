CREATE TABLE message_search_documents (
  message_id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL,
  search_text TEXT NOT NULL
    CHECK (length(search_text) <= 32768),
  updated_at INTEGER NOT NULL
    CHECK (updated_at > 0),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_message_search_documents_mailbox
  ON message_search_documents(mailbox_id, message_id);

INSERT INTO message_search_documents (message_id, mailbox_id, search_text, updated_at)
SELECT
  m.id,
  m.mailbox_id,
  substr(lower(
    m.subject || ' ' || m.sender || ' ' || m.recipients || ' ' || m.cc || ' '
    || m.text_preview || ' '
    || COALESCE((
      SELECT group_concat(a.filename, ' ') FROM attachments AS a WHERE a.message_id = m.id
    ), '') || ' '
    || COALESCE((
      SELECT group_concat(r.address, ' ') FROM outbound_recipients AS r
      WHERE r.message_id = m.id
    ), '')
  ), 1, 32768),
  m.updated_at
FROM messages AS m;

CREATE TRIGGER trg_message_search_insert
AFTER INSERT ON messages
BEGIN
  INSERT INTO message_search_documents (message_id, mailbox_id, search_text, updated_at)
  VALUES (
    NEW.id,
    NEW.mailbox_id,
    substr(lower(
      NEW.subject || ' ' || NEW.sender || ' ' || NEW.recipients || ' '
      || NEW.cc || ' ' || NEW.text_preview
    ), 1, 32768),
    NEW.updated_at
  );
END;

CREATE TRIGGER trg_message_search_update
AFTER UPDATE OF subject, sender, recipients, cc, text_preview ON messages
BEGIN
  UPDATE message_search_documents
  SET search_text = substr(lower(
    NEW.subject || ' ' || NEW.sender || ' ' || NEW.recipients || ' ' || NEW.cc || ' '
    || NEW.text_preview || ' '
    || COALESCE((
      SELECT group_concat(a.filename, ' ') FROM attachments AS a WHERE a.message_id = NEW.id
    ), '') || ' '
    || COALESCE((
      SELECT group_concat(r.address, ' ') FROM outbound_recipients AS r
      WHERE r.message_id = NEW.id
    ), '')
  ), 1, 32768), updated_at = NEW.updated_at
  WHERE message_id = NEW.id;
END;

CREATE TRIGGER trg_message_search_attachment_insert
AFTER INSERT ON attachments
BEGIN
  UPDATE message_search_documents
  SET search_text = substr(search_text || ' ' || lower(NEW.filename), 1, 32768),
    updated_at = NEW.created_at
  WHERE message_id = NEW.message_id;
END;

CREATE TRIGGER trg_message_search_attachment_delete
AFTER DELETE ON attachments
BEGIN
  UPDATE message_search_documents
  SET search_text = substr(lower(
    (SELECT subject || ' ' || sender || ' ' || recipients || ' ' || cc || ' '
      || text_preview FROM messages WHERE id = OLD.message_id) || ' '
    || COALESCE((
      SELECT group_concat(a.filename, ' ') FROM attachments AS a WHERE a.message_id = OLD.message_id
    ), '') || ' '
    || COALESCE((
      SELECT group_concat(r.address, ' ') FROM outbound_recipients AS r
      WHERE r.message_id = OLD.message_id
    ), '')
  ), 1, 32768)
  WHERE message_id = OLD.message_id
    AND EXISTS (SELECT 1 FROM messages WHERE id = OLD.message_id);
END;

CREATE TRIGGER trg_message_search_recipient_insert
AFTER INSERT ON outbound_recipients
BEGIN
  UPDATE message_search_documents
  SET search_text = substr(search_text || ' ' || lower(NEW.address), 1, 32768)
  WHERE message_id = NEW.message_id;
END;

CREATE TRIGGER trg_message_search_recipient_delete
AFTER DELETE ON outbound_recipients
BEGIN
  UPDATE message_search_documents
  SET search_text = substr(lower(
    (SELECT subject || ' ' || sender || ' ' || recipients || ' ' || cc || ' '
      || text_preview FROM messages WHERE id = OLD.message_id) || ' '
    || COALESCE((
      SELECT group_concat(a.filename, ' ') FROM attachments AS a WHERE a.message_id = OLD.message_id
    ), '') || ' '
    || COALESCE((
      SELECT group_concat(r.address, ' ') FROM outbound_recipients AS r
      WHERE r.message_id = OLD.message_id
    ), '')
  ), 1, 32768)
  WHERE message_id = OLD.message_id
    AND EXISTS (SELECT 1 FROM messages WHERE id = OLD.message_id);
END;
