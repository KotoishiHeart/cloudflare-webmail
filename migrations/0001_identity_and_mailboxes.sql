CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 1 AND 128),
  email TEXT NOT NULL COLLATE NOCASE
    CHECK (length(email) BETWEEN 3 AND 320),
  display_name TEXT
    CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (updated_at >= created_at)
) STRICT;

CREATE UNIQUE INDEX ux_users_email
  ON users(email COLLATE NOCASE);

CREATE TABLE access_identities (
  issuer TEXT NOT NULL
    CHECK (length(issuer) BETWEEN 1 AND 2048),
  subject TEXT NOT NULL
    CHECK (length(subject) BETWEEN 1 AND 512),
  user_id TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE
    CHECK (length(email) BETWEEN 3 AND 320),
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (updated_at >= created_at),
  last_seen_at INTEGER NOT NULL
    CHECK (last_seen_at >= created_at),
  PRIMARY KEY (issuer, subject),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_access_identities_user_id
  ON access_identities(user_id);

CREATE TABLE mailboxes (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) BETWEEN 1 AND 128),
  display_name TEXT NOT NULL
    CHECK (length(display_name) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (updated_at >= created_at)
) STRICT;

CREATE TABLE mailbox_addresses (
  address TEXT PRIMARY KEY NOT NULL COLLATE NOCASE
    CHECK (length(address) BETWEEN 3 AND 320),
  mailbox_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('primary', 'alias')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (updated_at >= created_at),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX ux_mailbox_addresses_active_primary
  ON mailbox_addresses(mailbox_id)
  WHERE kind = 'primary' AND status = 'active';

CREATE INDEX idx_mailbox_addresses_mailbox_status
  ON mailbox_addresses(mailbox_id, status);

CREATE TABLE mailbox_memberships (
  mailbox_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('viewer', 'operator', 'owner')),
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (updated_at >= created_at),
  PRIMARY KEY (mailbox_id, user_id),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_mailbox_memberships_user_mailbox
  ON mailbox_memberships(user_id, mailbox_id);
