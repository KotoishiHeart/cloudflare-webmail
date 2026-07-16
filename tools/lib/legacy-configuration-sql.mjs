import {
  compoundKey,
  flag,
  guard,
  ownerSql,
  q,
  sql,
  targetLabelId,
  targetRuleId,
  values,
} from './legacy-sql-values.mjs';

export function buildLegacyConfigurationPlan(
  configuration,
  mappings,
  batchId,
  importedAt,
) {
  const statements = [];
  const labelIds = new Map();
  const ruleIds = new Map();
  const counts = { labels: 0, labelSources: 0, messageLabels: 0, rules: 0, preferences: 0 };
  for (const mapping of mappings) {
    for (const label of configuration.labels) {
      const id = targetLabelId(mapping.mailboxId, label.key);
      labelIds.set(compoundKey(mapping.mailboxId, label.key), id);
      statements.push(renderLabel(label, id, mapping.mailboxId, batchId, importedAt));
      counts.labels += 1;
      counts.labelSources += label.sourceKeys.length;
    }
  }
  for (const mapping of mappings) {
    for (const rule of configuration.rules) {
      const id = targetRuleId(mapping.mailboxId, rule.sourceId);
      ruleIds.set(compoundKey(mapping.mailboxId, rule.sourceId), id);
      const labelId = rule.actionLabelKey === ''
        ? null : labelIds.get(compoundKey(mapping.mailboxId, rule.actionLabelKey));
      if (rule.actionLabelKey !== '' && labelId === undefined) {
        throw new Error('legacy rule action label was not planned');
      }
      statements.push(renderRule(
        rule, id, mapping.mailboxId, labelId ?? null, batchId, importedAt,
      ));
      counts.rules += 1;
    }
  }
  for (const preference of configuration.preferences) {
    statements.push(renderPreference(preference, batchId, importedAt));
    counts.preferences += 1;
  }
  return {
    statements,
    counts,
    labelId(mailboxId, labelKey) {
      return labelIds.get(compoundKey(mailboxId, labelKey));
    },
    ruleId(mailboxId, sourceRuleId) {
      return ruleIds.get(compoundKey(mailboxId, sourceRuleId));
    },
  };
}

export function renderLegacyMessageLabelSql(
  plan,
  association,
  messageId,
  batchId,
  importedAt,
) {
  const labelId = plan.labelId(association.mailboxId, association.labelKey);
  if (labelId === undefined) throw new Error('legacy message label target was not planned');
  const ruleId = association.sourceRuleId === ''
    ? null : plan.ruleId(association.mailboxId, association.sourceRuleId) ?? null;
  const targetKey = `${messageId}:${labelId}`;
  plan.counts.messageLabels += 1;
  return [sql(`
    INSERT INTO message_labels (
      message_id, mailbox_id, label_id, source_rule_id, applied_by_user_id, created_at
    )
    SELECT ${values([
      messageId, association.mailboxId, labelId, ruleId, null, association.createdAt,
    ])}
    WHERE EXISTS (
      SELECT 1 FROM messages WHERE id = ${q(messageId)}
        AND mailbox_id = ${q(association.mailboxId)}
    ) AND EXISTS (
      SELECT 1 FROM mailbox_labels WHERE id = ${q(labelId)}
        AND mailbox_id = ${q(association.mailboxId)}
    )
    ON CONFLICT(message_id, label_id) DO NOTHING
  `), provenance({
    batchId,
    kind: 'message_label',
    sourceKey: association.sourceKey,
    targetKey,
    mailboxId: association.mailboxId,
    importedAt,
    exists: `SELECT 1 FROM message_labels WHERE message_id = ${q(messageId)} AND label_id = ${q(labelId)}`,
  }), guard(`NOT EXISTS (
    SELECT 1 FROM message_labels WHERE message_id = ${q(messageId)}
      AND mailbox_id = ${q(association.mailboxId)} AND label_id = ${q(labelId)}
  )`)].join('\n\n');
}

function renderLabel(label, id, mailboxId, batchId, importedAt) {
  const owner = ownerSql(mailboxId);
  const sourceRows = label.sourceKeys.map((sourceKey) => provenance({
    batchId,
    kind: 'label',
    sourceKey,
    targetKey: id,
    mailboxId,
    importedAt,
    exists: `SELECT 1 FROM mailbox_labels WHERE id = ${q(id)} AND mailbox_id = ${q(mailboxId)}`,
  }));
  return [sql(`
    INSERT INTO mailbox_labels (
      id, mailbox_id, name, color, description,
      created_by_user_id, created_at, updated_at
    )
    SELECT ${values([
      id, mailboxId, label.name, label.color, label.description,
    ])}, (${owner}), ${label.createdAt}, ${label.updatedAt}
    WHERE EXISTS (${owner})
    ON CONFLICT(id) DO NOTHING
  `), ...sourceRows, guard(`NOT EXISTS (
    SELECT 1 FROM mailbox_labels WHERE id = ${q(id)} AND mailbox_id = ${q(mailboxId)}
      AND name = ${q(label.name)} COLLATE NOCASE AND color = ${q(label.color)}
      AND description = ${q(label.description)}
  )`)].join('\n\n');
}

function renderRule(rule, id, mailboxId, labelId, batchId, importedAt) {
  const actions = { ...rule.actions, labelIds: labelId === null ? [] : [labelId] };
  const conditionsJson = JSON.stringify(rule.conditions);
  const actionsJson = JSON.stringify(actions);
  const owner = ownerSql(mailboxId);
  const labelSql = labelId === null ? [] : [sql(`
    INSERT INTO mail_rule_labels (rule_id, mailbox_id, label_id)
    SELECT ${values([id, mailboxId, labelId])}
    WHERE EXISTS (SELECT 1 FROM mail_rules WHERE id = ${q(id)} AND mailbox_id = ${q(mailboxId)})
      AND EXISTS (SELECT 1 FROM mailbox_labels WHERE id = ${q(labelId)} AND mailbox_id = ${q(mailboxId)})
    ON CONFLICT(rule_id, label_id) DO NOTHING
  `)];
  return [sql(`
    INSERT INTO mail_rules (
      id, mailbox_id, name, enabled, priority, conditions_json, actions_json,
      apply_existing, apply_incoming, stop_processing, revision,
      created_by_user_id, last_preview_count, last_preview_at, last_run_at,
      created_at, updated_at
    )
    SELECT ${values([
      id, mailboxId, rule.name, flag(rule.enabled), rule.priority,
      conditionsJson, actionsJson, flag(rule.applyExisting), flag(rule.applyIncoming),
      0, 1,
    ])}, (${owner}), ${values([
      rule.lastPreviewCount, rule.lastPreviewAt, rule.lastRunAt,
      rule.createdAt, rule.updatedAt,
    ])}
    WHERE EXISTS (${owner})
    ON CONFLICT(id) DO NOTHING
  `), ...labelSql, provenance({
    batchId,
    kind: 'mail_rule',
    sourceKey: rule.sourceId,
    targetKey: id,
    mailboxId,
    importedAt,
    exists: `SELECT 1 FROM mail_rules WHERE id = ${q(id)} AND mailbox_id = ${q(mailboxId)}`,
  }), guard(`NOT EXISTS (
    SELECT 1 FROM mail_rules WHERE id = ${q(id)} AND mailbox_id = ${q(mailboxId)}
      AND name = ${q(rule.name)} COLLATE NOCASE
      AND conditions_json = ${q(conditionsJson)} AND actions_json = ${q(actionsJson)}
      AND enabled = ${flag(rule.enabled)} AND priority = ${rule.priority}
      AND apply_existing = ${flag(rule.applyExisting)}
      AND apply_incoming = ${flag(rule.applyIncoming)}
  )`)].join('\n\n');
}

function renderPreference(preference, batchId, importedAt) {
  const defaultMailbox = preference.defaultMailboxId;
  const membership = defaultMailbox === null ? '1 = 1' : `EXISTS (
    SELECT 1 FROM mailbox_memberships
    WHERE user_id = u.id AND mailbox_id = ${q(defaultMailbox)}
  )`;
  return [sql(`
    INSERT INTO user_preferences (
      user_id, theme, page_size, default_folder, show_html_by_default,
      compact_layout, created_at, updated_at, default_mailbox_id
    )
    SELECT u.id, 'system', ${preference.pageSize}, 'inbox', 1,
      ${flag(preference.compactLayout)}, ${preference.updatedAt}, ${preference.updatedAt},
      ${defaultMailbox === null ? 'NULL' : q(defaultMailbox)}
    FROM users AS u WHERE u.email = ${q(preference.email)} COLLATE NOCASE
      AND ${membership}
    ON CONFLICT(user_id) DO UPDATE SET
      page_size = excluded.page_size,
      default_mailbox_id = excluded.default_mailbox_id,
      compact_layout = excluded.compact_layout,
      updated_at = MAX(user_preferences.created_at, excluded.updated_at)
  `), sql(`
    INSERT INTO migration_configuration_sources (
      batch_id, source_kind, source_key, target_key,
      mailbox_id, user_id, imported_at
    )
    SELECT ${values([
      batchId, 'user_preference', preference.email,
    ])}, u.id, ${defaultMailbox === null ? 'NULL' : q(defaultMailbox)}, u.id, ${importedAt}
    FROM users AS u WHERE u.email = ${q(preference.email)} COLLATE NOCASE
      AND EXISTS (SELECT 1 FROM user_preferences WHERE user_id = u.id)
    ON CONFLICT(batch_id, source_kind, source_key, target_key) DO NOTHING
  `), guard(`NOT EXISTS (
    SELECT 1 FROM user_preferences AS p JOIN users AS u ON u.id = p.user_id
    WHERE u.email = ${q(preference.email)} COLLATE NOCASE
      AND p.page_size = ${preference.pageSize}
      AND p.compact_layout = ${flag(preference.compactLayout)}
      AND p.default_mailbox_id IS ${defaultMailbox === null ? 'NULL' : q(defaultMailbox)}
  )`)].join('\n\n');
}

function provenance(input) {
  return sql(`
    INSERT INTO migration_configuration_sources (
      batch_id, source_kind, source_key, target_key,
      mailbox_id, user_id, imported_at
    )
    SELECT ${values([
      input.batchId, input.kind, input.sourceKey, input.targetKey, input.mailboxId, null,
      input.importedAt,
    ])}
    WHERE EXISTS (${input.exists})
    ON CONFLICT(batch_id, source_kind, source_key, target_key) DO NOTHING
  `);
}
