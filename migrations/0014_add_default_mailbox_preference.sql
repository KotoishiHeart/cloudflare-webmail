ALTER TABLE user_preferences
  ADD COLUMN default_mailbox_id TEXT
  REFERENCES mailboxes(id) ON DELETE SET NULL;
