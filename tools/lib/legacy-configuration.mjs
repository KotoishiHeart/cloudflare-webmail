import {
  normalizeLegacyLabel,
  normalizeLegacyPreference,
  normalizeLegacyRule,
  safeVisible,
} from './legacy-configuration-values.mjs';

const REQUIRED = {
  labels: ['id', 'name', 'color', 'description', 'created_at', 'updated_at'],
  message_labels: ['message_id', 'label_id', 'source_rule_id', 'created_at'],
  mail_rules: [
    'id', 'name', 'enabled', 'priority', 'match_json', 'action_json',
    'apply_existing', 'apply_incoming', 'last_preview_count', 'last_preview_at',
    'last_run_at', 'created_at', 'updated_at',
  ],
  app_settings: ['key', 'value', 'updated_at'],
};

export function readLegacyConfiguration(database, mappings, now) {
  const rules = readRules(database, now);
  const labels = readLabels(database, rules, now);
  const preferences = readPreferences(database, mappings, now);
  const messageLabelStatement = table(database, 'message_labels')
    ? database.prepare(`
      SELECT label_id, source_rule_id, created_at FROM message_labels
      WHERE message_id = ? ORDER BY CAST(label_id AS INTEGER)
    `)
    : null;
  if (messageLabelStatement !== null) requireColumns(database, 'message_labels');
  return {
    labels: labels.items,
    labelBySourceId: labels.bySourceId,
    labelByName: labels.byName,
    rules,
    ruleBySourceId: new Map(rules.map((rule) => [rule.sourceId, rule])),
    preferences,
    messageLabelStatement,
    sourceCounts: {
      labels: labels.sourceCount,
      messageLabels: messageLabelStatement === null
        ? 0 : scalar(database, 'SELECT COUNT(*) FROM message_labels'),
      rules: rules.length,
      preferences: preferences.length,
    },
  };
}

export function legacyMessageLabels(configuration, sourceMessageId, mailboxId) {
  if (configuration.messageLabelStatement === null) return [];
  return configuration.messageLabelStatement.all(sourceMessageId).map((row) => {
    const label = configuration.labelBySourceId.get(String(row.label_id));
    if (label === undefined) throw new Error('legacy message label has no label definition');
    const sourceRuleId = text(row.source_rule_id, 128);
    return {
      sourceKey: `${sourceMessageId}:${String(row.label_id)}`,
      labelKey: label.key,
      sourceRuleId,
      createdAt: positive(row.created_at, 'message label created_at'),
      mailboxId,
    };
  });
}

function readLabels(database, rules, now) {
  const items = [];
  const byName = new Map();
  const bySourceId = new Map();
  let sourceCount = 0;
  if (table(database, 'labels')) {
    requireColumns(database, 'labels');
    for (const row of database.prepare(`
      SELECT id, name, color, description, created_at, updated_at
      FROM labels ORDER BY CAST(id AS INTEGER), name
    `).all()) {
      sourceCount += 1;
      const sourceId = text(row.id, 128, true);
      const label = ensureLabel(items, byName, normalizeLegacyLabel(row, sourceId, now));
      label.sourceKeys.push(`label:${sourceId}`);
      bySourceId.set(sourceId, label);
    }
  }
  for (const rule of rules) {
    if (rule.actionLabel === '') continue;
    const label = ensureLabel(items, byName, {
      name: rule.actionLabel,
      color: '#64748b',
      description: safeVisible(`Migrated from legacy rule ${rule.name}`, 240, ''),
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    });
    if (label.sourceKeys.length === 0) label.sourceKeys.push(`rule:${rule.sourceId}:label`);
    rule.actionLabelKey = label.key;
  }
  return { items, byName, bySourceId, sourceCount };
}

function ensureLabel(items, byName, input) {
  const key = input.name.toLocaleLowerCase('en-US');
  let label = byName.get(key);
  if (label === undefined) {
    label = { key, sourceKeys: [], ...input };
    items.push(label);
    byName.set(key, label);
  }
  return label;
}

function readRules(database, now) {
  if (!table(database, 'mail_rules')) return [];
  requireColumns(database, 'mail_rules');
  const names = new Set();
  return database.prepare(`
    SELECT id, name, enabled, priority, match_json, action_json,
      apply_existing, apply_incoming, last_preview_count, last_preview_at,
      last_run_at, created_at, updated_at
    FROM mail_rules ORDER BY priority, created_at, id
  `).all().map((row, index) => normalizeLegacyRule(row, index, names, now));
}

function readPreferences(database, mappings, now) {
  if (!table(database, 'app_settings')) return [];
  requireColumns(database, 'app_settings');
  const mailboxByAddress = new Map(mappings.map((item) => [item.sourceAddress, item.mailboxId]));
  return database.prepare(`
    SELECT key, value, updated_at FROM app_settings
    WHERE key LIKE 'user_pref:%' ORDER BY key
  `).all().map((row) => normalizeLegacyPreference(row, mailboxByAddress, now));
}

function requireColumns(database, name) {
  const columns = new Set(database.prepare(`PRAGMA table_info('${name}')`).all().map((row) => row.name));
  const missing = REQUIRED[name].filter((column) => !columns.has(column));
  if (missing.length > 0) throw new Error(`legacy ${name} table is missing column: ${missing[0]}`);
}

function table(database, name) {
  return database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;
}

function text(value, maximum, required = false) {
  const normalized = String(value ?? '');
  if ((required && normalized === '') || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error('legacy configuration identifier is invalid');
  }
  return normalized;
}

function positive(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`legacy ${name} is invalid`);
  return number;
}

function scalar(database, sql) {
  return Number(Object.values(database.prepare(sql).get() ?? {})[0] ?? 0);
}
