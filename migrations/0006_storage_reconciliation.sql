CREATE TABLE maintenance_cursors (
  task TEXT PRIMARY KEY NOT NULL
    CHECK (length(task) BETWEEN 1 AND 64),
  cursor TEXT NOT NULL DEFAULT ''
    CHECK (length(cursor) <= 2048),
  cycle_started_at INTEGER NOT NULL
    CHECK (cycle_started_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (updated_at >= cycle_started_at)
) STRICT, WITHOUT ROWID;

CREATE TABLE storage_issues (
  issue_type TEXT NOT NULL
    CHECK (issue_type IN (
      'orphan_staging_raw',
      'orphan_staging_payload',
      'invalid_staging_payload',
      'staging_recovery_failed',
      'staging_cleanup_failed',
      'canonical_object_missing',
      'orphan_canonical_object'
    )),
  object_key TEXT NOT NULL
    CHECK (length(object_key) BETWEEN 1 AND 1024),
  mailbox_id TEXT,
  message_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('open', 'resolved')),
  details TEXT NOT NULL DEFAULT ''
    CHECK (length(details) <= 1024),
  occurrences INTEGER NOT NULL DEFAULT 1
    CHECK (occurrences BETWEEN 1 AND 1000000),
  first_seen_at INTEGER NOT NULL
    CHECK (first_seen_at > 0),
  last_seen_at INTEGER NOT NULL
    CHECK (last_seen_at >= first_seen_at),
  resolved_at INTEGER NOT NULL DEFAULT 0
    CHECK (resolved_at >= 0),
  PRIMARY KEY (issue_type, object_key)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_storage_issues_status
  ON storage_issues(status, issue_type, last_seen_at);
