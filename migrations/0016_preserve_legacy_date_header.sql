ALTER TABLE message_migration_sources
  ADD COLUMN source_date_header TEXT NOT NULL DEFAULT ''
    CHECK (length(source_date_header) <= 8192);
