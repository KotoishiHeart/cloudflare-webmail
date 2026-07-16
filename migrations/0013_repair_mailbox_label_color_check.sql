PRAGMA defer_foreign_keys = ON;

CREATE TABLE mailbox_labels_new (
  id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE
    CHECK (length(name) BETWEEN 1 AND 80),
  color TEXT NOT NULL DEFAULT '#64748b'
    CHECK (
      length(color) = 7
      AND substr(color, 1, 1) = '#'
      AND substr(color, 2) NOT GLOB '*[^0-9A-Fa-f]*'
    ),
  description TEXT NOT NULL DEFAULT ''
    CHECK (length(description) <= 240),
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (updated_at >= created_at),
  PRIMARY KEY (id),
  UNIQUE (id, mailbox_id),
  UNIQUE (mailbox_id, name),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE message_labels_new (
  message_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  source_rule_id TEXT,
  applied_by_user_id TEXT,
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  PRIMARY KEY (message_id, label_id),
  FOREIGN KEY (message_id, mailbox_id)
    REFERENCES messages(id, mailbox_id) ON DELETE CASCADE,
  FOREIGN KEY (label_id, mailbox_id)
    REFERENCES mailbox_labels_new(id, mailbox_id) ON DELETE CASCADE,
  FOREIGN KEY (applied_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE mail_rule_labels_new (
  rule_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (rule_id, label_id),
  FOREIGN KEY (rule_id, mailbox_id)
    REFERENCES mail_rules(id, mailbox_id) ON DELETE CASCADE,
  FOREIGN KEY (label_id, mailbox_id)
    REFERENCES mailbox_labels_new(id, mailbox_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

INSERT INTO mailbox_labels_new (
  id,
  mailbox_id,
  name,
  color,
  description,
  created_by_user_id,
  created_at,
  updated_at
)
SELECT
  id,
  mailbox_id,
  name,
  color,
  description,
  created_by_user_id,
  created_at,
  updated_at
FROM mailbox_labels;

INSERT INTO message_labels_new (
  message_id,
  mailbox_id,
  label_id,
  source_rule_id,
  applied_by_user_id,
  created_at
)
SELECT
  message_id,
  mailbox_id,
  label_id,
  source_rule_id,
  applied_by_user_id,
  created_at
FROM message_labels;

INSERT INTO mail_rule_labels_new (
  rule_id,
  mailbox_id,
  label_id
)
SELECT
  rule_id,
  mailbox_id,
  label_id
FROM mail_rule_labels;

DROP TABLE message_labels;
DROP TABLE mail_rule_labels;
DROP TABLE mailbox_labels;

ALTER TABLE mailbox_labels_new RENAME TO mailbox_labels;
ALTER TABLE message_labels_new RENAME TO message_labels;
ALTER TABLE mail_rule_labels_new RENAME TO mail_rule_labels;

CREATE INDEX idx_mailbox_labels_name
  ON mailbox_labels(mailbox_id, name COLLATE NOCASE);

CREATE INDEX idx_message_labels_mailbox_label
  ON message_labels(mailbox_id, label_id, created_at DESC);

CREATE INDEX idx_message_labels_source_rule
  ON message_labels(source_rule_id, created_at DESC)
  WHERE source_rule_id IS NOT NULL;

CREATE INDEX idx_mail_rule_labels_label
  ON mail_rule_labels(mailbox_id, label_id, rule_id);

PRAGMA defer_foreign_keys = OFF;
