import type { MailRule, MailRuleDefinition } from './mail-rule-domain.js';
import {
  normalizeMailRuleDefinition,
  parseMailRuleActions,
  parseMailRuleConditions,
} from './mail-rule-domain.js';
import { DatabaseInputError, normalizeId, requireTimestamp } from './validation.js';

type MailRuleRow = {
  id: string;
  mailbox_id: string;
  name: string;
  enabled: number;
  priority: number;
  conditions_json: string;
  actions_json: string;
  apply_existing: number;
  apply_incoming: number;
  stop_processing: number;
  revision: number;
  last_preview_count: number;
  last_preview_at: number | null;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
};

export async function listMailboxRules(db: D1Database, mailboxIdInput: string): Promise<MailRule[]> {
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const result = await db.prepare(`${RULE_SELECT}
    WHERE mailbox_id = ? ORDER BY priority, created_at, id
  `).bind(mailboxId).all<MailRuleRow>();
  return result.results.map(toMailRule);
}

export async function getMailboxRule(
  db: D1Database,
  mailboxIdInput: string,
  ruleIdInput: string,
): Promise<MailRule | null> {
  const row = await db.prepare(`${RULE_SELECT} WHERE mailbox_id = ? AND id = ?`).bind(
    normalizeId(mailboxIdInput, 'mailboxId'),
    normalizeId(ruleIdInput, 'ruleId'),
  ).first<MailRuleRow>();
  return row === null ? null : toMailRule(row);
}

export async function createMailboxRule(
  db: D1Database,
  input: MailRuleDefinition & {
    id: string;
    mailboxId: string;
    userId: string;
    now: number;
  },
): Promise<MailRule> {
  const values = identifiers(input);
  const rule = normalizeMailRuleDefinition(input);
  await requireRuleLabels(db, values.mailboxId, rule.actions.labelIds);
  const result = await db.prepare(`
    INSERT INTO mail_rules (
      id, mailbox_id, name, enabled, priority, conditions_json, actions_json,
      apply_existing, apply_incoming, stop_processing, created_by_user_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mailbox_id, name) DO NOTHING
  `).bind(
    values.id, values.mailboxId, rule.name, flag(rule.enabled), rule.priority,
    JSON.stringify(rule.conditions), JSON.stringify(rule.actions),
    flag(rule.applyExisting), flag(rule.applyIncoming), flag(rule.stopProcessing),
    values.userId, values.now, values.now,
  ).run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new DatabaseInputError('name', 'already exists in this mailbox');
  }
  await replaceRuleLabels(db, values.id, values.mailboxId, rule.actions.labelIds);
  const created = await getMailboxRule(db, values.mailboxId, values.id);
  if (created === null) throw new Error('created rule became unavailable');
  return created;
}

export async function updateMailboxRule(
  db: D1Database,
  input: MailRuleDefinition & { id: string; mailboxId: string; now: number },
): Promise<MailRule | null> {
  const id = normalizeId(input.id, 'ruleId');
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  const now = requireTimestamp(input.now);
  if (await getMailboxRule(db, mailboxId, id) === null) return null;
  const rule = normalizeMailRuleDefinition(input);
  await requireRuleLabels(db, mailboxId, rule.actions.labelIds);
  const conflict = await db.prepare(`
    SELECT 1 AS found FROM mail_rules
    WHERE mailbox_id = ? AND name = ? COLLATE NOCASE AND id <> ? LIMIT 1
  `).bind(mailboxId, rule.name, id).first<{ found: number }>();
  if (conflict !== null) throw new DatabaseInputError('name', 'already exists in this mailbox');
  const statements = [db.prepare(`
    UPDATE mail_rules SET name = ?, enabled = ?, priority = ?, conditions_json = ?,
      actions_json = ?, apply_existing = ?, apply_incoming = ?, stop_processing = ?,
      revision = revision + 1, updated_at = ?
    WHERE mailbox_id = ? AND id = ?
  `).bind(
    rule.name, flag(rule.enabled), rule.priority, JSON.stringify(rule.conditions),
    JSON.stringify(rule.actions), flag(rule.applyExisting), flag(rule.applyIncoming),
    flag(rule.stopProcessing), now, mailboxId, id,
  ), db.prepare('DELETE FROM mail_rule_labels WHERE rule_id = ? AND mailbox_id = ?').bind(
    id, mailboxId,
  ), ...rule.actions.labelIds.map((labelId) => db.prepare(`
    INSERT INTO mail_rule_labels (rule_id, mailbox_id, label_id) VALUES (?, ?, ?)
  `).bind(id, mailboxId, labelId))];
  const result = await db.batch(statements);
  if (Number(result[0]?.meta.changes ?? 0) === 0) return null;
  return getMailboxRule(db, mailboxId, id);
}

export async function deleteMailboxRule(
  db: D1Database,
  mailboxIdInput: string,
  ruleIdInput: string,
): Promise<boolean> {
  const result = await db.prepare('DELETE FROM mail_rules WHERE mailbox_id = ? AND id = ?').bind(
    normalizeId(mailboxIdInput, 'mailboxId'),
    normalizeId(ruleIdInput, 'ruleId'),
  ).run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function listIncomingMailboxRules(
  db: D1Database,
  mailboxIdInput: string,
): Promise<MailRule[]> {
  const result = await db.prepare(`${RULE_SELECT}
    WHERE mailbox_id = ? AND enabled = 1 AND apply_incoming = 1
    ORDER BY priority, created_at, id LIMIT 50
  `).bind(normalizeId(mailboxIdInput, 'mailboxId')).all<MailRuleRow>();
  return result.results.map(toMailRule);
}

const RULE_SELECT = `SELECT id, mailbox_id, name, enabled, priority,
  conditions_json, actions_json, apply_existing, apply_incoming, stop_processing, revision,
  last_preview_count, last_preview_at, last_run_at, created_at, updated_at
  FROM mail_rules`;

function identifiers(input: { id: string; mailboxId: string; userId: string; now: number }) {
  return {
    id: normalizeId(input.id, 'ruleId'),
    mailboxId: normalizeId(input.mailboxId, 'mailboxId'),
    userId: normalizeId(input.userId, 'userId'),
    now: requireTimestamp(input.now),
  };
}

async function requireRuleLabels(db: D1Database, mailboxId: string, labelIds: string[]): Promise<void> {
  if (labelIds.length === 0) return;
  const normalized = labelIds.map((id) => normalizeId(id, 'labelId'));
  const placeholders = normalized.map(() => '?').join(', ');
  const row = await db.prepare(`
    SELECT COUNT(*) AS count FROM mailbox_labels
    WHERE mailbox_id = ? AND id IN (${placeholders})
  `).bind(mailboxId, ...normalized).first<{ count: number }>();
  if (Number(row?.count ?? 0) !== normalized.length) {
    throw new DatabaseInputError('actions.labelIds', 'contains a label from another mailbox');
  }
}

async function replaceRuleLabels(
  db: D1Database,
  ruleId: string,
  mailboxId: string,
  labelIds: string[],
): Promise<void> {
  if (labelIds.length === 0) return;
  await db.batch(labelIds.map((labelId) => db.prepare(`
    INSERT INTO mail_rule_labels (rule_id, mailbox_id, label_id) VALUES (?, ?, ?)
  `).bind(ruleId, mailboxId, labelId)));
}

function toMailRule(row: MailRuleRow): MailRule {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    name: row.name,
    enabled: row.enabled === 1,
    priority: row.priority,
    conditions: parseMailRuleConditions(row.conditions_json),
    actions: parseMailRuleActions(row.actions_json),
    applyExisting: row.apply_existing === 1,
    applyIncoming: row.apply_incoming === 1,
    stopProcessing: row.stop_processing === 1,
    revision: row.revision,
    lastPreviewCount: row.last_preview_count,
    lastPreviewAt: row.last_preview_at,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function flag(value: boolean): number {
  return value ? 1 : 0;
}
