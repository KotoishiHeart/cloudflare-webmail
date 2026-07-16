CREATE TABLE migration_batches (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 1 AND 128),
  source_system TEXT NOT NULL
    CHECK (source_system = 'cloudflare-webmail-archived'),
  source_database_sha256 TEXT NOT NULL
    CHECK (length(source_database_sha256) = 64 AND source_database_sha256 NOT GLOB '*[^0-9a-f]*'),
  mapping_sha256 TEXT NOT NULL
    CHECK (length(mapping_sha256) = 64 AND mapping_sha256 NOT GLOB '*[^0-9a-f]*'),
  snapshot_sha256 TEXT NOT NULL
    CHECK (length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  expected_messages INTEGER NOT NULL
    CHECK (expected_messages > 0),
  source_objects INTEGER NOT NULL
    CHECK (source_objects > 0),
  staged_objects INTEGER NOT NULL
    CHECK (staged_objects > 0),
  created_at INTEGER NOT NULL
    CHECK (created_at > 0)
) STRICT;

CREATE TABLE message_migration_sources (
  batch_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL
    CHECK (length(source_record_id) BETWEEN 1 AND 128),
  message_id TEXT NOT NULL,
  source_account TEXT NOT NULL
    CHECK (length(source_account) BETWEEN 3 AND 320),
  source_direction TEXT NOT NULL
    CHECK (source_direction IN ('in', 'sent')),
  source_raw_key TEXT NOT NULL
    CHECK (length(source_raw_key) BETWEEN 1 AND 1024),
  source_body_text_key TEXT NOT NULL DEFAULT ''
    CHECK (length(source_body_text_key) <= 1024),
  source_body_html_key TEXT NOT NULL DEFAULT ''
    CHECK (length(source_body_html_key) <= 1024),
  source_bcc TEXT NOT NULL DEFAULT ''
    CHECK (length(source_bcc) <= 8192),
  source_thread_message_id TEXT NOT NULL DEFAULT ''
    CHECK (length(source_thread_message_id) <= 128),
  compose_mode TEXT NOT NULL DEFAULT ''
    CHECK (length(compose_mode) <= 64),
  send_status TEXT NOT NULL DEFAULT ''
    CHECK (length(send_status) <= 64),
  provider TEXT NOT NULL DEFAULT ''
    CHECK (length(provider) <= 64),
  source_deleted_at INTEGER,
  source_created_at INTEGER NOT NULL
    CHECK (source_created_at > 0),
  imported_at INTEGER NOT NULL
    CHECK (imported_at > 0),
  PRIMARY KEY (batch_id, source_record_id),
  UNIQUE (batch_id, message_id),
  FOREIGN KEY (batch_id) REFERENCES migration_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_message_migration_sources_message
  ON message_migration_sources(message_id);

CREATE INDEX idx_message_migration_sources_account
  ON message_migration_sources(source_account, source_created_at DESC);
