CREATE TABLE mail_rules (
  id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE
    CHECK (length(name) BETWEEN 1 AND 120),
  enabled INTEGER NOT NULL DEFAULT 1
    CHECK (enabled IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 100
    CHECK (priority BETWEEN 1 AND 9999),
  conditions_json TEXT NOT NULL
    CHECK (json_valid(conditions_json)),
  actions_json TEXT NOT NULL
    CHECK (json_valid(actions_json)),
  apply_existing INTEGER NOT NULL DEFAULT 0
    CHECK (apply_existing IN (0, 1)),
  apply_incoming INTEGER NOT NULL DEFAULT 1
    CHECK (apply_incoming IN (0, 1)),
  stop_processing INTEGER NOT NULL DEFAULT 0
    CHECK (stop_processing IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision > 0),
  created_by_user_id TEXT NOT NULL,
  last_preview_count INTEGER NOT NULL DEFAULT 0
    CHECK (last_preview_count >= 0),
  last_preview_at INTEGER,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (updated_at >= created_at),
  UNIQUE (id, mailbox_id),
  UNIQUE (mailbox_id, name),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_mail_rules_mailbox_priority
  ON mail_rules(mailbox_id, enabled DESC, priority, created_at, id);

CREATE INDEX idx_mail_rules_incoming
  ON mail_rules(mailbox_id, apply_incoming, enabled, priority, created_at, id);

CREATE TABLE mail_rule_labels (
  rule_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (rule_id, label_id),
  FOREIGN KEY (rule_id, mailbox_id)
    REFERENCES mail_rules(id, mailbox_id) ON DELETE CASCADE,
  FOREIGN KEY (label_id, mailbox_id)
    REFERENCES mailbox_labels(id, mailbox_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_mail_rule_labels_label
  ON mail_rule_labels(mailbox_id, label_id, rule_id);

CREATE TABLE mail_rule_runs (
  id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_name TEXT NOT NULL
    CHECK (length(rule_name) BETWEEN 1 AND 120),
  rule_version INTEGER NOT NULL
    CHECK (rule_version > 0),
  mode TEXT NOT NULL
    CHECK (mode IN ('preview', 'apply_existing', 'incoming', 'undo')),
  status TEXT NOT NULL
    CHECK (status IN ('running', 'ready', 'completed', 'applied', 'blocked', 'failed', 'undone')),
  conditions_json TEXT NOT NULL
    CHECK (json_valid(conditions_json)),
  actions_json TEXT NOT NULL
    CHECK (json_valid(actions_json)),
  source_run_id TEXT,
  target_message_id TEXT,
  matched_count INTEGER NOT NULL DEFAULT 0
    CHECK (matched_count >= 0),
  changed_count INTEGER NOT NULL DEFAULT 0
    CHECK (changed_count >= 0),
  summary TEXT NOT NULL DEFAULT ''
    CHECK (length(summary) <= 500),
  created_by_user_id TEXT,
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  completed_at INTEGER,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE,
  FOREIGN KEY (source_run_id) REFERENCES mail_rule_runs(id) ON DELETE SET NULL,
  FOREIGN KEY (target_message_id, mailbox_id)
    REFERENCES messages(id, mailbox_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_mail_rule_runs_mailbox_created
  ON mail_rule_runs(mailbox_id, created_at DESC, id DESC);

CREATE INDEX idx_mail_rule_runs_rule_created
  ON mail_rule_runs(rule_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX ux_mail_rule_run_source_mode
  ON mail_rule_runs(source_run_id, mode)
  WHERE source_run_id IS NOT NULL AND mode IN ('apply_existing', 'undo');

CREATE UNIQUE INDEX ux_mail_rule_run_incoming_target
  ON mail_rule_runs(rule_id, target_message_id, mode)
  WHERE target_message_id IS NOT NULL AND mode = 'incoming';

CREATE TABLE mail_rule_run_matches (
  run_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  action_json TEXT NOT NULL
    CHECK (json_valid(action_json)),
  before_json TEXT NOT NULL
    CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL
    CHECK (json_valid(after_json)),
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  PRIMARY KEY (run_id, message_id),
  FOREIGN KEY (run_id) REFERENCES mail_rule_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id, mailbox_id)
    REFERENCES messages(id, mailbox_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_mail_rule_run_matches_message
  ON mail_rule_run_matches(mailbox_id, message_id, created_at DESC);
