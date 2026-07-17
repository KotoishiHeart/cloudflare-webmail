import { deterministicUuid } from './migration-message.mjs';
import { legacyMessageLabels, readLegacyConfiguration } from './legacy-configuration.mjs';
import { targetLabelId, targetRuleId } from './legacy-sql-values.mjs';
import { legacyDeltaExpectedSha256 } from './legacy-delta-compare.mjs';

export function collectLegacyConfigurationDelta(options) {
  const baseline = readLegacyConfiguration(
    options.baselineDatabase, options.mapping.mappings, options.createdAt,
  );
  const final = readLegacyConfiguration(
    options.finalDatabase, options.mapping.mappings, options.createdAt,
  );
  const operations = {
    labelUpserts: [],
    ruleMutations: [],
    preferenceMutations: [],
    messageLabelMutations: [],
    labelDeletes: [],
  };
  collectLabels(operations, baseline, final, options.mapping.mappings);
  collectRules(operations, baseline, final, options.mapping.mappings);
  collectPreferences(operations, baseline, final);
  collectMessageLabels(operations, options, baseline, final);
  const list = Object.values(operations).flat();
  return {
    operations,
    changes: list.map((operation) => operation.change),
    counts: list.reduce((counts, operation) => {
      counts[operation.change.kind][operation.change.action] += 1;
      return counts;
    }, emptyCounts()),
  };
}

function collectLabels(operations, baseline, final, mappings) {
  const before = new Map(baseline.labels.map((label) => [label.key, label]));
  const after = new Map(final.labels.map((label) => [label.key, label]));
  for (const mapping of mappings) {
    for (const [key, label] of after) {
      const prior = before.get(key);
      if (prior !== undefined && same(labelValue(prior), labelValue(label))) continue;
      add(operations.labelUpserts, 'label', prior === undefined ? 'insert' : 'update',
        `label:${key}`, targetLabelId(mapping.mailboxId, key), mapping.mailboxId,
        { prior, final: label });
    }
    for (const [key, label] of before) {
      if (after.has(key)) continue;
      add(operations.labelDeletes, 'label', 'delete', `label:${key}`,
        targetLabelId(mapping.mailboxId, key), mapping.mailboxId, { prior: label });
    }
  }
}

function collectRules(operations, baseline, final, mappings) {
  const before = new Map(baseline.rules.map((rule) => [rule.sourceId, rule]));
  const after = new Map(final.rules.map((rule) => [rule.sourceId, rule]));
  for (const mapping of mappings) {
    for (const [sourceId, rule] of after) {
      const prior = before.get(sourceId);
      if (prior !== undefined && same(ruleValue(prior), ruleValue(rule))) continue;
      add(operations.ruleMutations, 'mail_rule', prior === undefined ? 'insert' : 'update',
        sourceId, targetRuleId(mapping.mailboxId, sourceId), mapping.mailboxId,
        { prior, final: rule });
    }
    for (const [sourceId, rule] of before) {
      if (after.has(sourceId)) continue;
      add(operations.ruleMutations, 'mail_rule', 'delete', sourceId,
        targetRuleId(mapping.mailboxId, sourceId), mapping.mailboxId, { prior: rule });
    }
  }
}

function collectPreferences(operations, baseline, final) {
  const before = new Map(baseline.preferences.map((item) => [item.email, item]));
  const after = new Map(final.preferences.map((item) => [item.email, item]));
  for (const [email, preference] of after) {
    const prior = before.get(email);
    if (prior !== undefined && same(preferenceValue(prior), preferenceValue(preference))) continue;
    add(operations.preferenceMutations, 'user_preference',
      prior === undefined ? 'insert' : 'update', email, email, null,
      { prior, final: preference });
  }
  for (const [email, preference] of before) {
    if (!after.has(email)) {
      add(operations.preferenceMutations, 'user_preference', 'delete', email, email, null,
        { prior: preference });
    }
  }
}

function collectMessageLabels(operations, options, baseline, final) {
  const before = messageAssociations(options.baselineDatabase, options.mapping, baseline);
  const after = messageAssociations(options.finalDatabase, options.mapping, final);
  for (const [targetKey, association] of after) {
    const prior = before.get(targetKey);
    if (prior !== undefined && same(associationValue(prior), associationValue(association))) continue;
    add(operations.messageLabelMutations, 'message_label',
      prior === undefined ? 'insert' : 'update', association.sourceKey, targetKey,
      association.mailboxId, { prior, final: association });
  }
  for (const [targetKey, association] of before) {
    if (!after.has(targetKey)) {
      add(operations.messageLabelMutations, 'message_label', 'delete',
        association.sourceKey, targetKey, association.mailboxId, { prior: association });
    }
  }
}

function messageAssociations(database, mapping, configuration) {
  if (configuration.messageLabelStatement === null) return new Map();
  const mappings = new Map(mapping.mappings.map((item) => [item.sourceAddress, item]));
  const output = new Map();
  for (const row of database.prepare(`
    SELECT id, raw_sha256, LOWER(account_email) AS account_email FROM messages ORDER BY id
  `).iterate()) {
    const target = mappings.get(String(row.account_email));
    if (target === undefined) continue;
    const messageId = deterministicUuid(
      `${target.mailboxId}\u0000${String(row.raw_sha256).toLowerCase()}`,
    );
    for (const item of legacyMessageLabels(configuration, String(row.id), target.mailboxId)) {
      const labelId = targetLabelId(target.mailboxId, item.labelKey);
      const ruleId = item.sourceRuleId === '' || !configuration.ruleBySourceId.has(item.sourceRuleId)
        ? null : targetRuleId(target.mailboxId, item.sourceRuleId);
      const targetKey = `${messageId}:${labelId}`;
      if (output.has(targetKey)) throw new Error('legacy message label target is duplicated');
      output.set(targetKey, {
        ...item, messageId, labelId, ruleId, targetKey,
      });
    }
  }
  return output;
}

function add(output, kind, action, sourceKey, targetKey, mailboxId, values) {
  const expected = values.final ?? null;
  output.push({
    ...values,
    change: {
      kind, action, sourceKey, targetKey, mailboxId,
      expectedSha256: legacyDeltaExpectedSha256({ kind, action, targetKey, expected }),
    },
  });
}

function labelValue(value) {
  return pick(value, ['name', 'color', 'description', 'createdAt', 'updatedAt']);
}

function ruleValue(value) {
  return pick(value, [
    'name', 'enabled', 'priority', 'conditions', 'actions', 'actionLabelKey',
    'applyExisting', 'applyIncoming', 'lastPreviewCount', 'lastPreviewAt', 'lastRunAt',
    'createdAt', 'updatedAt',
  ]);
}

function preferenceValue(value) {
  return pick(value, ['email', 'pageSize', 'compactLayout', 'defaultMailboxId', 'updatedAt']);
}

function associationValue(value) {
  return pick(value, ['messageId', 'labelId', 'ruleId', 'createdAt']);
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function emptyCounts() {
  const actions = () => ({ insert: 0, update: 0, delete: 0 });
  return {
    label: actions(), message_label: actions(), mail_rule: actions(),
    user_preference: actions(),
  };
}
