import { queryD1 } from './backup-cloudflare.mjs';

export function auditLegacyDeltaTarget(manifest, options, runner) {
  const rows = queryD1(`
    SELECT baseline_batch_id, message_batch_id, source_database_sha256,
      mapping_sha256, snapshot_sha256, change_set_sha256,
      expected_new_messages, expected_flag_updates, expected_configuration_mutations,
      expected_objects, expected_changes
    FROM legacy_migration_deltas WHERE id = '${manifest.deltaId}'
  `, options, runner);
  if (rows.length !== 1) throw new Error('target D1 legacy delta was not found exactly once');
  const delta = rows[0];
  for (const [field, expected] of [
    ['baseline_batch_id', manifest.baselineBatchId],
    ['message_batch_id', manifest.messageBatchId],
    ['source_database_sha256', manifest.sourceDatabaseSha256],
    ['mapping_sha256', manifest.mappingSha256],
    ['snapshot_sha256', manifest.snapshotSha256],
    ['change_set_sha256', manifest.changeSetSha256],
    ['expected_new_messages', manifest.counts.newMessages],
    ['expected_flag_updates', manifest.counts.flagUpdates],
    ['expected_configuration_mutations', manifest.counts.configurationMutations],
    ['expected_objects', manifest.counts.objects],
    ['expected_changes', manifest.counts.changes],
  ]) {
    if (String(delta[field] ?? '') !== String(expected ?? '')) {
      throw new Error(`target D1 legacy delta mismatch: ${field}`);
    }
  }
  auditDeltaSourceCounts(manifest, options, runner);
  auditDeltaTargets(manifest, options, runner);
  if (manifest.messageBatchId !== null) auditDeltaMessageBatch(manifest, options, runner);
  return {
    deltaId: manifest.deltaId,
    baselineBatchId: manifest.baselineBatchId,
    messageBatchId: manifest.messageBatchId,
    newMessages: manifest.counts.newMessages,
    flagUpdates: manifest.counts.flagUpdates,
    configurationMutations: manifest.counts.configurationMutations,
    changes: manifest.counts.changes,
    objects: manifest.counts.objects,
  };
}

function auditDeltaSourceCounts(manifest, options, runner) {
  const rows = queryD1(`
    SELECT source_kind, action, COUNT(*) AS count
    FROM legacy_migration_delta_sources WHERE delta_id = '${manifest.deltaId}'
    GROUP BY source_kind, action ORDER BY source_kind, action
  `, options, runner);
  const actual = new Map(rows.map((row) => [`${row.source_kind}:${row.action}`, Number(row.count)]));
  const expected = new Map([
    ['message:insert', manifest.counts.newMessages],
    ['message_flags:update', manifest.counts.flagUpdates],
  ]);
  for (const [kind, actions] of Object.entries(manifest.configuration.counts)) {
    for (const [action, count] of Object.entries(actions)) expected.set(`${kind}:${action}`, count);
  }
  for (const [key, count] of expected) {
    if (Number(actual.get(key) ?? 0) !== count) {
      throw new Error(`target D1 legacy delta source mismatch: ${key}`);
    }
    actual.delete(key);
  }
  if (actual.size !== 0) throw new Error('target D1 contains unexpected legacy delta sources');
}

function auditDeltaTargets(manifest, options, runner) {
  const rows = queryD1(`
    SELECT COUNT(*) AS changes,
      COALESCE(SUM(CASE
        WHEN s.source_kind = 'message' THEN EXISTS (
          SELECT 1 FROM messages AS m JOIN message_migration_sources AS p ON p.message_id = m.id
          WHERE m.id = s.target_key AND m.mailbox_id = s.mailbox_id
            AND p.batch_id = '${manifest.messageBatchId ?? ''}' AND p.source_record_id = s.source_key
        )
        WHEN s.source_kind = 'message_flags' THEN EXISTS (
          SELECT 1 FROM messages AS m JOIN message_migration_sources AS p ON p.message_id = m.id
          WHERE m.id = s.target_key AND m.mailbox_id = s.mailbox_id
            AND p.batch_id = '${manifest.baselineBatchId}' AND p.source_record_id = s.source_key
        )
        WHEN s.source_kind = 'label' THEN (
          (s.action = 'delete' AND NOT EXISTS (
            SELECT 1 FROM mailbox_labels WHERE id = s.target_key AND mailbox_id = s.mailbox_id
          )) OR (s.action <> 'delete' AND EXISTS (
            SELECT 1 FROM mailbox_labels WHERE id = s.target_key AND mailbox_id = s.mailbox_id
          ))
        )
        WHEN s.source_kind = 'mail_rule' THEN (
          (s.action = 'delete' AND NOT EXISTS (
            SELECT 1 FROM mail_rules WHERE id = s.target_key AND mailbox_id = s.mailbox_id
          )) OR (s.action <> 'delete' AND EXISTS (
            SELECT 1 FROM mail_rules WHERE id = s.target_key AND mailbox_id = s.mailbox_id
          ))
        )
        WHEN s.source_kind = 'message_label' THEN (
          (s.action = 'delete' AND NOT EXISTS (
            SELECT 1 FROM message_labels
            WHERE message_id || ':' || label_id = s.target_key AND mailbox_id = s.mailbox_id
          )) OR (s.action <> 'delete' AND EXISTS (
            SELECT 1 FROM message_labels
            WHERE message_id || ':' || label_id = s.target_key AND mailbox_id = s.mailbox_id
          ))
        )
        WHEN s.source_kind = 'user_preference' THEN (
          (s.action = 'delete' AND NOT EXISTS (
            SELECT 1 FROM user_preferences AS p JOIN users AS u ON u.id = p.user_id
            WHERE u.email = s.target_key COLLATE NOCASE
          )) OR (s.action <> 'delete' AND EXISTS (
            SELECT 1 FROM user_preferences AS p JOIN users AS u ON u.id = p.user_id
            WHERE u.email = s.target_key COLLATE NOCASE
          ))
        ) ELSE 0 END), 0) AS valid_targets
    FROM legacy_migration_delta_sources AS s WHERE s.delta_id = '${manifest.deltaId}'
  `, options, runner);
  if (
    rows.length !== 1
    || Number(rows[0].changes) !== manifest.counts.changes
    || Number(rows[0].valid_targets) !== manifest.counts.changes
  ) throw new Error('target D1 legacy delta targets do not match the applied change set');
}

function auditDeltaMessageBatch(manifest, options, runner) {
  const rows = queryD1(`
    SELECT b.source_database_sha256, b.mapping_sha256, b.snapshot_sha256,
      b.expected_messages, b.source_objects, b.staged_objects,
      (SELECT COUNT(*) FROM message_migration_sources WHERE batch_id = b.id) AS imported_messages,
      (SELECT COALESCE(SUM(1 + (m.body_text_key IS NOT NULL) + (m.body_html_key IS NOT NULL)
        + m.attachment_count), 0)
       FROM message_migration_sources AS s JOIN messages AS m ON m.id = s.message_id
       WHERE s.batch_id = b.id) AS object_references,
      (SELECT COALESCE(SUM(m.status = 'quarantined'), 0)
       FROM message_migration_sources AS s JOIN messages AS m ON m.id = s.message_id
       WHERE s.batch_id = b.id) AS quarantined
    FROM migration_batches AS b WHERE b.id = '${manifest.messageBatchId}'
  `, options, runner);
  if (rows.length !== 1) throw new Error('target D1 delta message batch was not found exactly once');
  const row = rows[0];
  for (const [field, expected] of [
    ['source_database_sha256', manifest.sourceDatabaseSha256],
    ['mapping_sha256', manifest.mappingSha256],
    ['snapshot_sha256', manifest.snapshotSha256],
    ['expected_messages', manifest.counts.newMessages],
    ['source_objects', manifest.counts.sourceObjects],
    ['staged_objects', manifest.counts.objects],
    ['imported_messages', manifest.counts.newMessages],
    ['object_references', manifest.counts.objects],
    ['quarantined', manifest.counts.quarantined],
  ]) {
    if (String(row[field]) !== String(expected)) {
      throw new Error(`target D1 delta message batch mismatch: ${field}`);
    }
  }
}
