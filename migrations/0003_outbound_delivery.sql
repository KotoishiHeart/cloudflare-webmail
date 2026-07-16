CREATE TABLE outbound_deliveries (
  message_id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL
    CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  requested_by_user_id TEXT NOT NULL,
  sender_address TEXT NOT NULL COLLATE NOCASE
    CHECK (length(sender_address) BETWEEN 3 AND 320),
  sender_name TEXT NOT NULL
    CHECK (length(sender_name) BETWEEN 1 AND 160),
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 1000),
  enqueued_at INTEGER NOT NULL
    CHECK (enqueued_at > 0),
  next_attempt_at INTEGER NOT NULL
    CHECK (next_attempt_at > 0),
  lease_expires_at INTEGER NOT NULL DEFAULT 0
    CHECK (lease_expires_at >= 0),
  lease_token TEXT NOT NULL DEFAULT ''
    CHECK (length(lease_token) <= 128),
  provider_message_id TEXT NOT NULL DEFAULT ''
    CHECK (length(provider_message_id) <= 998),
  last_error_code TEXT NOT NULL DEFAULT ''
    CHECK (length(last_error_code) <= 64),
  last_error_message TEXT NOT NULL DEFAULT ''
    CHECK (length(last_error_message) <= 1024),
  sent_at INTEGER,
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (updated_at >= created_at),
  UNIQUE (mailbox_id, idempotency_key),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE,
  FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_outbound_deliveries_recovery
  ON outbound_deliveries(status, next_attempt_at, enqueued_at);

CREATE TABLE outbound_recipients (
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('to', 'cc', 'bcc')),
  ordinal INTEGER NOT NULL
    CHECK (ordinal BETWEEN 0 AND 49),
  address TEXT NOT NULL COLLATE NOCASE
    CHECK (length(address) BETWEEN 3 AND 320),
  PRIMARY KEY (message_id, kind, ordinal),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_outbound_recipients_address
  ON outbound_recipients(address COLLATE NOCASE);
