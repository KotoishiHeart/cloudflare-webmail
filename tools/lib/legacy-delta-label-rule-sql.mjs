import { renderLegacyDeltaSourceSql } from './legacy-delta-sql.mjs';
import {
  flag, guard, ownerSql, q, sql, targetLabelId, values,
} from './legacy-sql-values.mjs';

export function renderLegacyDeltaLabelSql(operation, delta) {
  const { change } = operation;
  const identity = `id = ${q(change.targetKey)} AND mailbox_id = ${q(change.mailboxId)}`;
  if (change.action === 'delete') {
    const absent = `SELECT 1 FROM mailboxes WHERE id = ${q(change.mailboxId)}
      AND NOT EXISTS (SELECT 1 FROM mailbox_labels WHERE ${identity})`;
    return [sql(`
      DELETE FROM mailbox_labels WHERE ${identity}
        AND ${ownership(delta, 'label', change.targetKey, change.mailboxId)}
    `), guard(`NOT EXISTS (${absent})`),
    renderLegacyDeltaSourceSql(change, delta, absent)].join('\n\n');
  }
  const label = operation.final;
  const expected = `SELECT 1 FROM mailbox_labels WHERE ${identity}
    AND name = ${q(label.name)} COLLATE NOCASE AND color = ${q(label.color)}
    AND description = ${q(label.description)} AND created_at = ${label.createdAt}
    AND updated_at = ${label.updatedAt}`;
  const mutation = change.action === 'insert' ? sql(`
    INSERT INTO mailbox_labels (
      id, mailbox_id, name, color, description,
      created_by_user_id, created_at, updated_at
    ) SELECT ${values([
      change.targetKey, change.mailboxId, label.name, label.color, label.description,
    ])}, (${ownerSql(change.mailboxId)}), ${label.createdAt}, ${label.updatedAt}
    WHERE EXISTS (${ownerSql(change.mailboxId)})
    ON CONFLICT(id) DO NOTHING
  `) : sql(`
    UPDATE mailbox_labels SET name = ${q(label.name)}, color = ${q(label.color)},
      description = ${q(label.description)}, created_at = ${label.createdAt},
      updated_at = ${label.updatedAt}
    WHERE ${identity}
      AND ${ownership(delta, 'label', change.targetKey, change.mailboxId)}
  `);
  return [mutation, guard(`NOT EXISTS (${expected})`),
    renderLegacyDeltaSourceSql(change, delta, expected)].join('\n\n');
}

export function renderLegacyDeltaRuleSql(operation, delta) {
  const { change } = operation;
  const identity = `id = ${q(change.targetKey)} AND mailbox_id = ${q(change.mailboxId)}`;
  if (change.action === 'delete') {
    const absent = `SELECT 1 FROM mailboxes WHERE id = ${q(change.mailboxId)}
      AND NOT EXISTS (SELECT 1 FROM mail_rules WHERE ${identity})`;
    return [sql(`
      DELETE FROM mail_rules WHERE ${identity}
        AND ${ownership(delta, 'mail_rule', change.targetKey, change.mailboxId)}
    `), guard(`NOT EXISTS (${absent})`),
    renderLegacyDeltaSourceSql(change, delta, absent)].join('\n\n');
  }
  const rule = operation.final;
  const labelId = rule.actionLabelKey === ''
    ? null : targetLabelId(change.mailboxId, rule.actionLabelKey);
  const conditionsJson = JSON.stringify(rule.conditions);
  const actionsJson = JSON.stringify({
    ...rule.actions,
    labelIds: labelId === null ? [] : [labelId],
  });
  const fields = [
    rule.name, flag(rule.enabled), rule.priority, conditionsJson, actionsJson,
    flag(rule.applyExisting), flag(rule.applyIncoming), rule.lastPreviewCount,
    rule.lastPreviewAt, rule.lastRunAt, rule.createdAt, rule.updatedAt,
  ];
  const mutation = change.action === 'insert'
    ? insertRule(change, fields)
    : updateRule(change, fields, delta);
  const relationGuard = labelId === null
    ? `EXISTS (SELECT 1 FROM mail_rule_labels WHERE rule_id = ${q(change.targetKey)})`
    : `NOT EXISTS (
      SELECT 1 FROM mail_rule_labels WHERE rule_id = ${q(change.targetKey)}
        AND mailbox_id = ${q(change.mailboxId)} AND label_id = ${q(labelId)}
    ) OR EXISTS (
      SELECT 1 FROM mail_rule_labels WHERE rule_id = ${q(change.targetKey)}
        AND label_id <> ${q(labelId)}
    )`;
  const expected = expectedRule(change, fields);
  const relations = [sql(`
    DELETE FROM mail_rule_labels WHERE rule_id = ${q(change.targetKey)}
      AND mailbox_id = ${q(change.mailboxId)}
  `), ...(labelId === null ? [] : [sql(`
    INSERT INTO mail_rule_labels (rule_id, mailbox_id, label_id)
    SELECT ${values([change.targetKey, change.mailboxId, labelId])}
    WHERE EXISTS (SELECT 1 FROM mail_rules WHERE ${identity})
      AND EXISTS (
        SELECT 1 FROM mailbox_labels WHERE id = ${q(labelId)}
          AND mailbox_id = ${q(change.mailboxId)}
      )
    ON CONFLICT(rule_id, label_id) DO NOTHING
  `)])];
  return [mutation, ...relations, guard(`NOT EXISTS (${expected}) OR ${relationGuard}`),
    renderLegacyDeltaSourceSql(change, delta, expected)].join('\n\n');
}

function insertRule(change, fields) {
  return sql(`
    INSERT INTO mail_rules (
      id, mailbox_id, name, enabled, priority, conditions_json, actions_json,
      apply_existing, apply_incoming, stop_processing, revision,
      created_by_user_id, last_preview_count, last_preview_at, last_run_at,
      created_at, updated_at
    ) SELECT ${values([
      change.targetKey, change.mailboxId, ...fields.slice(0, 7), 0, 1,
    ])}, (${ownerSql(change.mailboxId)}), ${values(fields.slice(7))}
    WHERE EXISTS (${ownerSql(change.mailboxId)})
    ON CONFLICT(id) DO NOTHING
  `);
}

function updateRule(change, fields, delta) {
  return sql(`
    UPDATE mail_rules SET name = ${q(fields[0])}, enabled = ${fields[1]},
      priority = ${fields[2]}, conditions_json = ${q(fields[3])},
      actions_json = ${q(fields[4])}, apply_existing = ${fields[5]},
      apply_incoming = ${fields[6]}, stop_processing = 0, revision = 1,
      last_preview_count = ${fields[7]}, last_preview_at = ${value(fields[8])},
      last_run_at = ${value(fields[9])}, created_at = ${fields[10]},
      updated_at = ${fields[11]}
    WHERE id = ${q(change.targetKey)} AND mailbox_id = ${q(change.mailboxId)}
      AND ${ownership(delta, 'mail_rule', change.targetKey, change.mailboxId)}
  `);
}

function expectedRule(change, fields) {
  return `SELECT 1 FROM mail_rules WHERE id = ${q(change.targetKey)}
    AND mailbox_id = ${q(change.mailboxId)} AND name = ${q(fields[0])} COLLATE NOCASE
    AND enabled = ${fields[1]} AND priority = ${fields[2]}
    AND conditions_json = ${q(fields[3])} AND actions_json = ${q(fields[4])}
    AND apply_existing = ${fields[5]} AND apply_incoming = ${fields[6]}
    AND stop_processing = 0 AND revision = 1 AND last_preview_count = ${fields[7]}
    AND last_preview_at IS ${nullable(fields[8])} AND last_run_at IS ${nullable(fields[9])}
    AND created_at = ${fields[10]} AND updated_at = ${fields[11]}`;
}

function ownership(delta, kind, targetKey, mailboxId) {
  return `EXISTS (
    SELECT 1 FROM migration_configuration_sources
    WHERE batch_id = ${q(delta.baselineBatchId)} AND source_kind = ${q(kind)}
      AND target_key = ${q(targetKey)} AND mailbox_id = ${q(mailboxId)}
  )`;
}

function nullable(input) {
  return input === null ? 'NULL' : String(input);
}

function value(input) {
  return input === null ? 'NULL' : String(input);
}
