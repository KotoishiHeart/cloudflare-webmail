CREATE TABLE migration_configuration_sources (
  batch_id TEXT NOT NULL,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('label', 'message_label', 'mail_rule', 'user_preference')),
  source_key TEXT NOT NULL
    CHECK (length(source_key) BETWEEN 1 AND 512),
  target_key TEXT NOT NULL
    CHECK (length(target_key) BETWEEN 1 AND 512),
  mailbox_id TEXT,
  user_id TEXT,
  imported_at INTEGER NOT NULL
    CHECK (imported_at > 0),
  PRIMARY KEY (batch_id, source_kind, source_key, target_key),
  CHECK (
    (source_kind = 'user_preference' AND user_id IS NOT NULL)
    OR (source_kind <> 'user_preference' AND mailbox_id IS NOT NULL)
  ),
  FOREIGN KEY (batch_id) REFERENCES migration_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_migration_configuration_sources_target
  ON migration_configuration_sources(batch_id, source_kind, target_key);

CREATE INDEX idx_migration_configuration_sources_mailbox
  ON migration_configuration_sources(mailbox_id, source_kind, imported_at DESC)
  WHERE mailbox_id IS NOT NULL;
