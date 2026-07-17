import { renderLegacyBatchSql, renderLegacyMessageSql } from './legacy-stage-sql.mjs';
import { flag, guard, q, sql, values } from './legacy-sql-values.mjs';

export function renderLegacyDeltaHeaderSql(delta, messageBatch) {
  const statements = messageBatch === null ? [] : [renderLegacyBatchSql(messageBatch)];
  statements.push(sql(`
    INSERT INTO legacy_migration_deltas (
      id, baseline_batch_id, message_batch_id, source_database_sha256,
      mapping_sha256, snapshot_sha256, change_set_sha256,
      expected_new_messages, expected_flag_updates, expected_configuration_mutations,
      expected_objects, expected_changes, created_at
    ) VALUES (${values([
      delta.id, delta.baselineBatchId, delta.messageBatchId, delta.sourceDatabaseSha256,
      delta.mappingSha256, delta.snapshotSha256, delta.changeSetSha256,
      delta.newMessages, delta.flagUpdates, delta.configurationMutations,
      delta.objects, delta.changes, delta.createdAt,
    ])}) ON CONFLICT(id) DO NOTHING
  `));
  statements.push(guard(`NOT EXISTS (
    SELECT 1 FROM legacy_migration_deltas WHERE id = ${q(delta.id)}
      AND baseline_batch_id = ${q(delta.baselineBatchId)}
      AND message_batch_id IS ${nullable(delta.messageBatchId)}
      AND source_database_sha256 = ${q(delta.sourceDatabaseSha256)}
      AND mapping_sha256 = ${q(delta.mappingSha256)}
      AND snapshot_sha256 = ${q(delta.snapshotSha256)}
      AND change_set_sha256 = ${q(delta.changeSetSha256)}
      AND expected_new_messages = ${delta.newMessages}
      AND expected_flag_updates = ${delta.flagUpdates}
      AND expected_configuration_mutations = ${delta.configurationMutations}
      AND expected_objects = ${delta.objects}
      AND expected_changes = ${delta.changes}
  )`));
  return statements.join('\n\n');
}

export function renderLegacyDeltaMessageSql(message, source, delta, change) {
  const exists = `SELECT 1 FROM messages AS m
    JOIN message_migration_sources AS s ON s.message_id = m.id
    WHERE m.id = ${q(message.id)} AND m.mailbox_id = ${q(message.mailboxId)}
      AND m.raw_sha256 = ${q(message.rawSha256)}
      AND s.batch_id = ${q(delta.messageBatchId)}
      AND s.source_record_id = ${q(source.id)}`;
  return [
    renderLegacyMessageSql(message, source, delta.messageBatchId, delta.createdAt),
    renderLegacyDeltaSourceSql(change, delta, exists),
  ].join('\n\n');
}

export function renderLegacyDeltaFlagSql(change, delta) {
  const flags = change.flags;
  const identity = `id = ${q(change.targetKey)} AND mailbox_id = ${q(change.mailboxId)}
    AND raw_sha256 = ${q(change.rawSha256)}`;
  const provenance = `batch_id = ${q(delta.baselineBatchId)}
    AND source_record_id = ${q(change.sourceKey)} AND message_id = ${q(change.targetKey)}`;
  const expected = `is_read = ${flag(flags.isRead)} AND is_starred = ${flag(flags.isStarred)}
    AND is_archived = ${flag(flags.isArchived)} AND is_deleted = ${flag(flags.isDeleted)}`;
  const exists = `SELECT 1 FROM messages WHERE ${identity} AND ${expected}`;
  return [sql(`
    UPDATE messages SET
      is_read = ${flag(flags.isRead)}, is_starred = ${flag(flags.isStarred)},
      is_archived = ${flag(flags.isArchived)}, is_deleted = ${flag(flags.isDeleted)},
      updated_at = MAX(created_at, ${delta.createdAt})
    WHERE ${identity} AND EXISTS (
      SELECT 1 FROM message_migration_sources WHERE ${provenance}
    )
  `), sql(`
    UPDATE message_migration_sources SET source_deleted_at = ${value(flags.deletedAt)}
    WHERE ${provenance}
  `), guard(`NOT EXISTS (${exists}) OR NOT EXISTS (
    SELECT 1 FROM message_migration_sources WHERE ${provenance}
      AND source_deleted_at IS ${nullable(flags.deletedAt)}
  )`), renderLegacyDeltaSourceSql(change, delta, exists)].join('\n\n');
}

export function renderLegacyDeltaSourceSql(change, delta, exists) {
  return [sql(`
    INSERT INTO legacy_migration_delta_sources (
      delta_id, source_kind, source_key, target_key, action,
      mailbox_id, expected_sha256, applied_at
    ) SELECT ${values([
      delta.id, change.kind, change.sourceKey, change.targetKey, change.action,
      change.mailboxId, change.expectedSha256, delta.createdAt,
    ])} WHERE EXISTS (${exists})
    ON CONFLICT(delta_id, source_kind, source_key, target_key, action) DO NOTHING
  `), guard(`NOT EXISTS (
    SELECT 1 FROM legacy_migration_delta_sources
    WHERE delta_id = ${q(delta.id)} AND source_kind = ${q(change.kind)}
      AND source_key = ${q(change.sourceKey)} AND target_key = ${q(change.targetKey)}
      AND action = ${q(change.action)} AND expected_sha256 = ${q(change.expectedSha256)}
  )`)].join('\n\n');
}

function nullable(value) {
  return value === null ? 'NULL' : q(value);
}

function value(input) {
  return input === null ? 'NULL' : String(input);
}
