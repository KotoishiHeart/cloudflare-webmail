CREATE UNIQUE INDEX ux_messages_id_mailbox
  ON messages(id, mailbox_id);

CREATE TABLE mailbox_labels (
  id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE
    CHECK (length(name) BETWEEN 1 AND 80),
  color TEXT NOT NULL DEFAULT '#64748b'
    CHECK (length(color) = 7 AND color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
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

CREATE INDEX idx_mailbox_labels_name
  ON mailbox_labels(mailbox_id, name COLLATE NOCASE);

CREATE TABLE message_labels (
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
    REFERENCES mailbox_labels(id, mailbox_id) ON DELETE CASCADE,
  FOREIGN KEY (applied_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_message_labels_mailbox_label
  ON message_labels(mailbox_id, label_id, created_at DESC);

CREATE INDEX idx_message_labels_source_rule
  ON message_labels(source_rule_id, created_at DESC)
  WHERE source_rule_id IS NOT NULL;

CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY NOT NULL,
  theme TEXT NOT NULL DEFAULT 'system'
    CHECK (theme IN ('system', 'light', 'dark')),
  page_size INTEGER NOT NULL DEFAULT 30
    CHECK (page_size BETWEEN 10 AND 50),
  default_folder TEXT NOT NULL DEFAULT 'inbox'
    CHECK (default_folder IN ('inbox', 'outbox', 'sent', 'starred', 'archive', 'trash', 'all')),
  show_html_by_default INTEGER NOT NULL DEFAULT 1
    CHECK (show_html_by_default IN (0, 1)),
  compact_layout INTEGER NOT NULL DEFAULT 0
    CHECK (compact_layout IN (0, 1)),
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (updated_at >= created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;
