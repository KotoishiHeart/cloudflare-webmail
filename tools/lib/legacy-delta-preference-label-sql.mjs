import { renderLegacyDeltaSourceSql } from './legacy-delta-sql.mjs';
import { flag, guard, q, sql, values } from './legacy-sql-values.mjs';

export function renderLegacyDeltaPreferenceSql(operation, delta) {
  const { change } = operation;
  const email = change.sourceKey;
  if (change.action === 'delete') {
    const absent = `SELECT 1 FROM users AS u WHERE u.email = ${q(email)} COLLATE NOCASE
      AND NOT EXISTS (SELECT 1 FROM user_preferences WHERE user_id = u.id)`;
    return [sql(`
      DELETE FROM user_preferences WHERE user_id IN (
        SELECT u.id FROM users AS u WHERE u.email = ${q(email)} COLLATE NOCASE
          AND ${preferenceOwnership(delta, email, 'user_preferences.user_id')}
      )
    `), guard(`NOT EXISTS (${absent})`),
    renderLegacyDeltaSourceSql(change, delta, absent)].join('\n\n');
  }
  const preference = operation.final;
  const membership = preference.defaultMailboxId === null ? '1 = 1' : `EXISTS (
    SELECT 1 FROM mailbox_memberships
    WHERE user_id = u.id AND mailbox_id = ${q(preference.defaultMailboxId)}
  )`;
  const defaultMailbox = preference.defaultMailboxId === null
    ? 'NULL' : q(preference.defaultMailboxId);
  const expected = `SELECT 1 FROM user_preferences AS p JOIN users AS u ON u.id = p.user_id
    WHERE u.email = ${q(email)} COLLATE NOCASE AND p.page_size = ${preference.pageSize}
      AND p.compact_layout = ${flag(preference.compactLayout)}
      AND p.default_mailbox_id IS ${defaultMailbox}
      AND p.updated_at = MAX(p.created_at, ${preference.updatedAt})`;
  const mutation = change.action === 'insert' ? sql(`
    INSERT INTO user_preferences (
      user_id, theme, page_size, default_folder, show_html_by_default,
      compact_layout, created_at, updated_at, default_mailbox_id
    ) SELECT u.id, 'system', ${preference.pageSize}, 'inbox', 1,
      ${flag(preference.compactLayout)}, ${preference.updatedAt}, ${preference.updatedAt},
      ${defaultMailbox}
    FROM users AS u WHERE u.email = ${q(email)} COLLATE NOCASE AND ${membership}
    ON CONFLICT(user_id) DO NOTHING
  `) : sql(`
    UPDATE user_preferences SET page_size = ${preference.pageSize},
      compact_layout = ${flag(preference.compactLayout)},
      default_mailbox_id = ${defaultMailbox},
      updated_at = MAX(created_at, ${preference.updatedAt})
    WHERE user_id IN (
      SELECT u.id FROM users AS u WHERE u.email = ${q(email)} COLLATE NOCASE
        AND ${membership}
        AND ${preferenceOwnership(delta, email, 'user_preferences.user_id')}
    )
  `);
  return [mutation, guard(`NOT EXISTS (${expected})`),
    renderLegacyDeltaSourceSql(change, delta, expected)].join('\n\n');
}

export function renderLegacyDeltaMessageLabelSql(operation, delta) {
  const { change } = operation;
  const association = operation.final ?? operation.prior;
  const identity = `message_id = ${q(association.messageId)}
    AND mailbox_id = ${q(change.mailboxId)} AND label_id = ${q(association.labelId)}`;
  if (change.action === 'delete') {
    const absent = `SELECT 1 FROM mailboxes WHERE id = ${q(change.mailboxId)}
      AND NOT EXISTS (SELECT 1 FROM message_labels WHERE ${identity})`;
    return [sql(`
      DELETE FROM message_labels WHERE ${identity}
        AND ${messageLabelOwnership(delta, operation.prior, change)}
    `), guard(`NOT EXISTS (${absent})`),
    renderLegacyDeltaSourceSql(change, delta, absent)].join('\n\n');
  }
  const expected = `SELECT 1 FROM message_labels WHERE ${identity}
    AND source_rule_id IS ${nullable(association.ruleId)}
    AND created_at = ${association.createdAt}`;
  const ruleExists = association.ruleId === null ? '1 = 1' : `EXISTS (
    SELECT 1 FROM mail_rules WHERE id = ${q(association.ruleId)}
      AND mailbox_id = ${q(change.mailboxId)}
  )`;
  const mutation = change.action === 'insert' ? sql(`
    INSERT INTO message_labels (
      message_id, mailbox_id, label_id, source_rule_id, applied_by_user_id, created_at
    ) SELECT ${values([
      association.messageId, change.mailboxId, association.labelId,
      association.ruleId, null, association.createdAt,
    ])} WHERE EXISTS (
      SELECT 1 FROM messages WHERE id = ${q(association.messageId)}
        AND mailbox_id = ${q(change.mailboxId)}
    ) AND EXISTS (
      SELECT 1 FROM mailbox_labels WHERE id = ${q(association.labelId)}
        AND mailbox_id = ${q(change.mailboxId)}
    ) AND ${ruleExists}
    ON CONFLICT(message_id, label_id) DO NOTHING
  `) : sql(`
    UPDATE message_labels SET source_rule_id = ${value(association.ruleId)},
      created_at = ${association.createdAt}
    WHERE ${identity} AND ${messageLabelOwnership(delta, operation.prior, change)}
  `);
  return [mutation, guard(`NOT EXISTS (${expected})`),
    renderLegacyDeltaSourceSql(change, delta, expected)].join('\n\n');
}

function preferenceOwnership(delta, email, userExpression) {
  return `EXISTS (
    SELECT 1 FROM migration_configuration_sources
    WHERE batch_id = ${q(delta.baselineBatchId)} AND source_kind = 'user_preference'
      AND source_key = ${q(email)} AND target_key = ${userExpression}
  )`;
}

function messageLabelOwnership(delta, association, change) {
  return `EXISTS (
    SELECT 1 FROM migration_configuration_sources
    WHERE batch_id = ${q(delta.baselineBatchId)} AND source_kind = 'message_label'
      AND source_key = ${q(association.sourceKey)} AND target_key = ${q(change.targetKey)}
      AND mailbox_id = ${q(change.mailboxId)}
  )`;
}

function nullable(input) {
  return input === null ? 'NULL' : q(input);
}

function value(input) {
  return input === null ? 'NULL' : q(input);
}
