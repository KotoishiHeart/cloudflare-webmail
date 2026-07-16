ALTER TABLE messages ADD COLUMN deleted_at INTEGER;

UPDATE messages
SET deleted_at = updated_at
WHERE is_deleted = 1 AND deleted_at IS NULL;

CREATE INDEX idx_messages_mailbox_deleted_at
  ON messages(mailbox_id, is_deleted, deleted_at, id);

CREATE TABLE system_administrators (
  user_id TEXT PRIMARY KEY NOT NULL,
  granted_by_user_id TEXT,
  source TEXT NOT NULL
    CHECK (source IN ('provisioning', 'admin')),
  granted_at INTEGER NOT NULL
    CHECK (granted_at > 0),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  actor_user_id TEXT,
  actor_email TEXT NOT NULL DEFAULT ''
    CHECK (length(actor_email) <= 320),
  mailbox_id TEXT,
  category TEXT NOT NULL
    CHECK (category IN ('session', 'message', 'label', 'preference', 'rule', 'admin', 'retention', 'delivery')),
  severity TEXT NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  action TEXT NOT NULL
    CHECK (length(action) BETWEEN 1 AND 160),
  target_type TEXT NOT NULL DEFAULT ''
    CHECK (length(target_type) <= 80),
  target_id TEXT NOT NULL DEFAULT ''
    CHECK (length(target_id) <= 320),
  request_id TEXT NOT NULL DEFAULT ''
    CHECK (length(request_id) <= 128),
  ip_address TEXT NOT NULL DEFAULT ''
    CHECK (length(ip_address) <= 64),
  user_agent TEXT NOT NULL DEFAULT ''
    CHECK (length(user_agent) <= 512),
  details_json TEXT NOT NULL DEFAULT '{}'
    CHECK (length(details_json) <= 8192 AND json_valid(details_json)),
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_audit_events_created
  ON audit_events(created_at DESC, id DESC);

CREATE INDEX idx_audit_events_actor
  ON audit_events(actor_user_id, created_at DESC, id DESC);

CREATE INDEX idx_audit_events_mailbox
  ON audit_events(mailbox_id, created_at DESC, id DESC)
  WHERE mailbox_id IS NOT NULL;

CREATE INDEX idx_audit_events_target
  ON audit_events(target_type, target_id, created_at DESC, id DESC);

CREATE TABLE delivery_events (
  id TEXT PRIMARY KEY NOT NULL,
  direction TEXT NOT NULL
    CHECK (direction IN ('inbound', 'outbound', 'system')),
  stage TEXT NOT NULL
    CHECK (stage IN ('routing', 'staging', 'queue', 'parse', 'storage', 'rules', 'provider', 'completed', 'recovery')),
  status TEXT NOT NULL
    CHECK (status IN ('info', 'succeeded', 'retrying', 'failed', 'rejected')),
  category TEXT NOT NULL
    CHECK (length(category) BETWEEN 1 AND 80),
  severity TEXT NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  mailbox_id TEXT,
  message_id TEXT NOT NULL DEFAULT ''
    CHECK (length(message_id) <= 128),
  provider TEXT NOT NULL DEFAULT ''
    CHECK (length(provider) <= 120),
  error_code TEXT NOT NULL DEFAULT ''
    CHECK (length(error_code) <= 80),
  summary TEXT NOT NULL DEFAULT ''
    CHECK (length(summary) <= 500),
  details_json TEXT NOT NULL DEFAULT '{}'
    CHECK (length(details_json) <= 8192 AND json_valid(details_json)),
  created_at INTEGER NOT NULL
    CHECK (created_at > 0)
) STRICT;

CREATE INDEX idx_delivery_events_created
  ON delivery_events(created_at DESC, id DESC);

CREATE INDEX idx_delivery_events_direction_status
  ON delivery_events(direction, status, created_at DESC, id DESC);

CREATE INDEX idx_delivery_events_message
  ON delivery_events(message_id, created_at DESC, id DESC)
  WHERE message_id <> '';

CREATE INDEX idx_delivery_events_mailbox
  ON delivery_events(mailbox_id, created_at DESC, id DESC)
  WHERE mailbox_id IS NOT NULL;
