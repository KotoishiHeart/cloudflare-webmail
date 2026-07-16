CREATE TABLE inbound_handoffs (
  message_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(message_id) BETWEEN 1 AND 128),
  mailbox_id TEXT NOT NULL,
  raw_key TEXT NOT NULL UNIQUE
    CHECK (length(raw_key) BETWEEN 1 AND 1024),
  queue_payload TEXT NOT NULL
    CHECK (length(queue_payload) BETWEEN 2 AND 8192 AND json_valid(queue_payload)),
  status TEXT NOT NULL
    CHECK (status IN (
      'staged', 'enqueued', 'queue_failed', 'processing', 'dead_letter', 'stored'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 1000),
  staging_deleted INTEGER NOT NULL DEFAULT 0
    CHECK (staging_deleted IN (0, 1)),
  stored_message_id TEXT,
  last_error_code TEXT NOT NULL DEFAULT ''
    CHECK (length(last_error_code) <= 64),
  last_error_message TEXT NOT NULL DEFAULT ''
    CHECK (length(last_error_message) <= 1024),
  received_at INTEGER NOT NULL
    CHECK (received_at > 0),
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (updated_at >= created_at),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE,
  FOREIGN KEY (stored_message_id) REFERENCES messages(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_inbound_handoffs_recovery
  ON inbound_handoffs(status, updated_at, received_at);

CREATE TABLE queue_dead_letters (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  source_queue TEXT NOT NULL
    CHECK (source_queue IN ('inbound', 'outbound')),
  dead_letter_queue TEXT NOT NULL
    CHECK (length(dead_letter_queue) BETWEEN 1 AND 128),
  source_message_id TEXT NOT NULL
    CHECK (length(source_message_id) BETWEEN 1 AND 128),
  message_id TEXT
    CHECK (message_id IS NULL OR length(message_id) BETWEEN 1 AND 128),
  mailbox_id TEXT
    CHECK (mailbox_id IS NULL OR length(mailbox_id) BETWEEN 1 AND 128),
  payload_json TEXT NOT NULL
    CHECK (length(payload_json) BETWEEN 1 AND 131072 AND json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL
    CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  payload_valid INTEGER NOT NULL
    CHECK (payload_valid IN (0, 1)),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'retry_requested', 'requeued', 'resolved')),
  occurrences INTEGER NOT NULL DEFAULT 1
    CHECK (occurrences BETWEEN 1 AND 1000000),
  first_seen_at INTEGER NOT NULL
    CHECK (first_seen_at > 0),
  last_seen_at INTEGER NOT NULL
    CHECK (last_seen_at >= first_seen_at),
  retry_requested_at INTEGER NOT NULL DEFAULT 0
    CHECK (retry_requested_at >= 0),
  requeued_at INTEGER NOT NULL DEFAULT 0
    CHECK (requeued_at >= 0),
  resolved_at INTEGER NOT NULL DEFAULT 0
    CHECK (resolved_at >= 0),
  last_error TEXT NOT NULL DEFAULT ''
    CHECK (length(last_error) <= 1024),
  UNIQUE (source_queue, payload_sha256)
) STRICT;

CREATE INDEX idx_queue_dead_letters_status
  ON queue_dead_letters(status, retry_requested_at, last_seen_at);

CREATE INDEX idx_queue_dead_letters_message
  ON queue_dead_letters(source_queue, message_id, status);
