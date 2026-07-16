CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 1 AND 128),
  mailbox_id TEXT NOT NULL,
  direction TEXT NOT NULL
    CHECK (direction IN ('inbound', 'outbound')),
  status TEXT NOT NULL
    CHECK (status IN ('ready', 'quarantined', 'draft', 'queued', 'sending', 'sent', 'failed')),
  processing_error TEXT NOT NULL DEFAULT ''
    CHECK (length(processing_error) <= 64),
  envelope_from TEXT NOT NULL DEFAULT ''
    CHECK (length(envelope_from) <= 320),
  delivered_to TEXT NOT NULL
    CHECK (length(delivered_to) BETWEEN 3 AND 320),
  rfc_message_id TEXT NOT NULL DEFAULT ''
    CHECK (length(rfc_message_id) <= 998),
  in_reply_to TEXT NOT NULL DEFAULT ''
    CHECK (length(in_reply_to) <= 998),
  references_header TEXT NOT NULL DEFAULT ''
    CHECK (length(references_header) <= 8192),
  subject TEXT NOT NULL DEFAULT ''
    CHECK (length(subject) <= 998),
  sender TEXT NOT NULL DEFAULT ''
    CHECK (length(sender) <= 2048),
  recipients TEXT NOT NULL DEFAULT ''
    CHECK (length(recipients) <= 8192),
  cc TEXT NOT NULL DEFAULT ''
    CHECK (length(cc) <= 8192),
  reply_to TEXT NOT NULL DEFAULT ''
    CHECK (length(reply_to) <= 4096),
  date_header TEXT NOT NULL DEFAULT ''
    CHECK (length(date_header) <= 256),
  received_at INTEGER NOT NULL
    CHECK (received_at > 0),
  text_preview TEXT NOT NULL DEFAULT ''
    CHECK (length(text_preview) <= 1024),
  raw_key TEXT NOT NULL
    CHECK (length(raw_key) BETWEEN 1 AND 1024),
  raw_sha256 TEXT NOT NULL
    CHECK (length(raw_sha256) = 64 AND raw_sha256 NOT GLOB '*[^0-9a-f]*'),
  raw_etag TEXT NOT NULL
    CHECK (length(raw_etag) BETWEEN 1 AND 256),
  raw_size INTEGER NOT NULL
    CHECK (raw_size BETWEEN 0 AND 26214400),
  body_text_key TEXT
    CHECK (body_text_key IS NULL OR length(body_text_key) BETWEEN 1 AND 1024),
  body_html_key TEXT
    CHECK (body_html_key IS NULL OR length(body_html_key) BETWEEN 1 AND 1024),
  attachment_count INTEGER NOT NULL DEFAULT 0
    CHECK (attachment_count BETWEEN 0 AND 100),
  is_read INTEGER NOT NULL DEFAULT 0
    CHECK (is_read IN (0, 1)),
  is_starred INTEGER NOT NULL DEFAULT 0
    CHECK (is_starred IN (0, 1)),
  is_archived INTEGER NOT NULL DEFAULT 0
    CHECK (is_archived IN (0, 1)),
  is_deleted INTEGER NOT NULL DEFAULT 0
    CHECK (is_deleted IN (0, 1)),
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (updated_at >= created_at),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX ux_messages_mailbox_raw_sha256
  ON messages(mailbox_id, raw_sha256);

CREATE INDEX idx_messages_mailbox_received
  ON messages(mailbox_id, is_deleted, received_at DESC, id DESC);

CREATE INDEX idx_messages_mailbox_rfc_message_id
  ON messages(mailbox_id, rfc_message_id)
  WHERE rfc_message_id <> '';

CREATE TABLE attachments (
  message_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL
    CHECK (ordinal BETWEEN 0 AND 99),
  filename TEXT NOT NULL
    CHECK (length(filename) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL
    CHECK (length(content_type) BETWEEN 1 AND 255),
  disposition TEXT NOT NULL
    CHECK (disposition IN ('attachment', 'inline', 'unspecified')),
  content_id TEXT NOT NULL DEFAULT ''
    CHECK (length(content_id) <= 998),
  size INTEGER NOT NULL
    CHECK (size BETWEEN 0 AND 26214400),
  sha256 TEXT NOT NULL
    CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  storage_key TEXT NOT NULL UNIQUE
    CHECK (length(storage_key) BETWEEN 1 AND 1024),
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  PRIMARY KEY (message_id, ordinal),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_attachments_sha256
  ON attachments(sha256);
