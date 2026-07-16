CREATE TABLE outbound_compositions (
  message_id TEXT PRIMARY KEY NOT NULL,
  compose_mode TEXT NOT NULL
    CHECK (compose_mode IN ('new', 'reply', 'forward')),
  source_message_id TEXT,
  created_at INTEGER NOT NULL
    CHECK (created_at > 0),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_outbound_compositions_source
  ON outbound_compositions(source_message_id)
  WHERE source_message_id IS NOT NULL;

INSERT INTO outbound_compositions (message_id, compose_mode, source_message_id, created_at)
SELECT id, 'new', NULL, created_at
FROM messages
WHERE direction = 'outbound';
