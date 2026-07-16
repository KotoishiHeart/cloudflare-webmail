import { renderMigratedMessageSql } from './migration-sql.mjs';

export function renderLegacyBatchSql(batch) {
  return [sql(`
    INSERT INTO migration_batches (
      id, source_system, source_database_sha256, mapping_sha256, snapshot_sha256,
      expected_messages, source_objects, staged_objects, created_at
    ) VALUES (
      ${values([
        batch.id, 'cloudflare-webmail-archived', batch.sourceDatabaseSha256,
        batch.mappingSha256, batch.snapshotSha256, batch.expectedMessages,
        batch.sourceObjects, batch.stagedObjects, batch.createdAt,
      ])}
    ) ON CONFLICT(id) DO NOTHING
  `), guard(`
    NOT EXISTS (
      SELECT 1 FROM migration_batches
      WHERE id = ${q(batch.id)}
        AND source_database_sha256 = ${q(batch.sourceDatabaseSha256)}
        AND mapping_sha256 = ${q(batch.mappingSha256)}
        AND snapshot_sha256 = ${q(batch.snapshotSha256)}
        AND expected_messages = ${batch.expectedMessages}
        AND source_objects = ${batch.sourceObjects}
        AND staged_objects = ${batch.stagedObjects}
    )
  `)].join('\n\n');
}

export function renderLegacyMessageSql(message, source, batchId, importedAt) {
  return [
    renderMigratedMessageSql(message, importedAt),
    sql(`
      INSERT INTO message_migration_sources (
        batch_id, source_record_id, message_id, source_account, source_direction,
        source_raw_key, source_body_text_key, source_body_html_key, source_bcc,
        source_thread_message_id, compose_mode, send_status, provider,
        source_deleted_at, source_created_at, imported_at
      )
      SELECT ${values([
        batchId, source.id, message.id, source.accountEmail, source.direction,
        source.rawKey, source.bodyTextKey, source.bodyHtmlKey, source.bcc,
        source.sourceMessageId, source.composeMode, source.sendStatus, source.provider,
        source.deletedAt, source.createdAt, importedAt,
      ])}
      WHERE EXISTS (
        SELECT 1 FROM messages
        WHERE id = ${q(message.id)} AND raw_sha256 = ${q(message.rawSha256)}
      )
      ON CONFLICT(batch_id, source_record_id) DO NOTHING
    `),
    guard(`
      NOT EXISTS (
        SELECT 1 FROM message_migration_sources
        WHERE batch_id = ${q(batchId)} AND source_record_id = ${q(source.id)}
          AND message_id = ${q(message.id)}
          AND source_account = ${q(source.accountEmail)}
          AND source_raw_key = ${q(source.rawKey)}
      )
    `),
  ].join('\n\n');
}

function guard(conflictExpression) {
  return sql(`
    SELECT CASE WHEN ${conflictExpression.trim()}
      THEN json_extract('CF_WEBMAIL_MIGRATION_CONFLICT', '$') ELSE 1 END
  `);
}

function values(items) {
  return items.map((value) => value === null ? 'NULL' : typeof value === 'number' ? String(value) : q(value)).join(', ');
}

function q(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sql(value) {
  return `${value.trim().replace(/^ {4}/gmu, '')};`;
}
