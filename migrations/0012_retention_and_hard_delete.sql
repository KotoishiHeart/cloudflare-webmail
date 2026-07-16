CREATE TABLE retention_policies (
  mailbox_id TEXT PRIMARY KEY NOT NULL,
  retention_days INTEGER NOT NULL DEFAULT 30
    CHECK (retention_days BETWEEN 1 AND 3650),
  exclude_starred INTEGER NOT NULL DEFAULT 1
    CHECK (exclude_starred IN (0, 1)),
  exclude_labeled INTEGER NOT NULL DEFAULT 1
    CHECK (exclude_labeled IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 0
    CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

INSERT INTO retention_policies (
  mailbox_id, retention_days, exclude_starred, exclude_labeled, enabled, created_at, updated_at
)
SELECT id, 30, 1, 1, 0, created_at, updated_at FROM mailboxes;

CREATE TABLE retention_runs (
  id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN (
      'building', 'preview', 'approved', 'running', 'completed', 'failed', 'cancelled'
    )),
  cutoff_at INTEGER NOT NULL CHECK (cutoff_at > 0),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  exclude_starred INTEGER NOT NULL CHECK (exclude_starred IN (0, 1)),
  exclude_labeled INTEGER NOT NULL CHECK (exclude_labeled IN (0, 1)),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  candidate_bytes INTEGER NOT NULL DEFAULT 0 CHECK (candidate_bytes >= 0),
  completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  backup_reference TEXT NOT NULL DEFAULT '' CHECK (length(backup_reference) <= 512),
  backup_manifest_sha256 TEXT NOT NULL DEFAULT ''
    CHECK (backup_manifest_sha256 = '' OR (
      length(backup_manifest_sha256) = 64
      AND backup_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )),
  backup_created_at INTEGER,
  error_summary TEXT NOT NULL DEFAULT '' CHECK (length(error_summary) <= 500),
  created_by_user_id TEXT,
  approved_by_user_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  approved_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (approved_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_retention_runs_status
  ON retention_runs(status, updated_at, id);

CREATE INDEX idx_retention_runs_mailbox
  ON retention_runs(mailbox_id, created_at DESC, id DESC);

CREATE TABLE retention_run_items (
  run_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'd1_deleted', 'completed', 'skipped', 'failed')),
  subject_snapshot TEXT NOT NULL DEFAULT '' CHECK (length(subject_snapshot) <= 998),
  received_at INTEGER NOT NULL CHECK (received_at > 0),
  deleted_at INTEGER NOT NULL CHECK (deleted_at > 0),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  object_keys_json TEXT NOT NULL
    CHECK (
      length(object_keys_json) BETWEEN 2 AND 131072
      AND json_valid(object_keys_json)
      AND json_type(object_keys_json) = 'array'
    ),
  next_object_index INTEGER NOT NULL DEFAULT 0 CHECK (next_object_index >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  lease_owner TEXT NOT NULL DEFAULT '' CHECK (length(lease_owner) <= 128),
  lease_expires_at INTEGER,
  d1_deleted_at INTEGER,
  error_summary TEXT NOT NULL DEFAULT '' CHECK (length(error_summary) <= 500),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (run_id, message_id),
  FOREIGN KEY (run_id) REFERENCES retention_runs(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_retention_run_items_work
  ON retention_run_items(status, lease_expires_at, updated_at, run_id);

CREATE INDEX idx_retention_run_items_message
  ON retention_run_items(message_id, created_at DESC);
