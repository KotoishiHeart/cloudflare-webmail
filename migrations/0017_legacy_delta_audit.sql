CREATE TABLE legacy_migration_deltas (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36),
  baseline_batch_id TEXT NOT NULL,
  message_batch_id TEXT,
  source_database_sha256 TEXT NOT NULL
    CHECK (length(source_database_sha256) = 64 AND source_database_sha256 NOT GLOB '*[^0-9a-f]*'),
  mapping_sha256 TEXT NOT NULL
    CHECK (length(mapping_sha256) = 64 AND mapping_sha256 NOT GLOB '*[^0-9a-f]*'),
  snapshot_sha256 TEXT NOT NULL
    CHECK (length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  change_set_sha256 TEXT NOT NULL
    CHECK (length(change_set_sha256) = 64 AND change_set_sha256 NOT GLOB '*[^0-9a-f]*'),
  expected_new_messages INTEGER NOT NULL
    CHECK (expected_new_messages >= 0),
  expected_flag_updates INTEGER NOT NULL
    CHECK (expected_flag_updates >= 0),
  expected_configuration_mutations INTEGER NOT NULL
    CHECK (expected_configuration_mutations >= 0),
  expected_objects INTEGER NOT NULL
    CHECK (expected_objects >= 0),
  expected_changes INTEGER NOT NULL
    CHECK (expected_changes >= 0),
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  CHECK (
    (expected_new_messages = 0 AND message_batch_id IS NULL AND expected_objects = 0)
    OR (expected_new_messages > 0 AND message_batch_id IS NOT NULL AND expected_objects > 0)
  ),
  FOREIGN KEY (baseline_batch_id) REFERENCES migration_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (message_batch_id) REFERENCES migration_batches(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE legacy_migration_delta_sources (
  delta_id TEXT NOT NULL,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN (
      'message', 'message_flags', 'label', 'message_label', 'mail_rule', 'user_preference'
    )),
  source_key TEXT NOT NULL
    CHECK (length(source_key) BETWEEN 1 AND 512),
  target_key TEXT NOT NULL
    CHECK (length(target_key) BETWEEN 1 AND 512),
  action TEXT NOT NULL
    CHECK (action IN ('insert', 'update', 'delete')),
  mailbox_id TEXT,
  expected_sha256 TEXT NOT NULL
    CHECK (length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
  applied_at INTEGER NOT NULL
    CHECK (applied_at > 0),
  PRIMARY KEY (delta_id, source_kind, source_key, target_key, action),
  FOREIGN KEY (delta_id) REFERENCES legacy_migration_deltas(id) ON DELETE RESTRICT,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_legacy_migration_delta_sources_target
  ON legacy_migration_delta_sources(delta_id, source_kind, target_key);

CREATE INDEX idx_legacy_migration_delta_sources_mailbox
  ON legacy_migration_delta_sources(mailbox_id, source_kind, applied_at DESC)
  WHERE mailbox_id IS NOT NULL;
