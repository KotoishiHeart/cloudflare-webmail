import type { MailRuleActions } from './mail-rule-domain.js';
import type { RuleMessageState } from './mail-rule-run-domain.js';

export type StoredRuleRunMatch = {
  message_id: string;
  action_json: string;
  before_json: string;
  after_json: string;
};

export async function getRuleMessageState(
  db: D1Database,
  mailboxId: string,
  messageId: string,
): Promise<RuleMessageState | null> {
  const row = await db.prepare(`
    SELECT is_starred, is_archived, is_deleted, deleted_at FROM messages
    WHERE mailbox_id = ? AND id = ?
  `).bind(mailboxId, messageId).first<{
    is_starred: number;
    is_archived: number;
    is_deleted: number;
    deleted_at: number | null;
  }>();
  if (row === null) return null;
  const labels = await db.prepare(`
    SELECT label_id FROM message_labels
    WHERE mailbox_id = ? AND message_id = ? ORDER BY label_id
  `).bind(mailboxId, messageId).all<{ label_id: string }>();
  return {
    isStarred: row.is_starred === 1,
    isArchived: row.is_archived === 1,
    isDeleted: row.is_deleted === 1,
    deletedAt: row.deleted_at,
    labelIds: labels.results.map((label) => label.label_id),
  };
}

export function actionStatements(
  db: D1Database,
  mailboxId: string,
  messageId: string,
  ruleId: string,
  actions: MailRuleActions,
  before: RuleMessageState,
  after: RuleMessageState,
  now: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (actions.star || actions.archive || actions.trash) {
    statements.push(db.prepare(`
      UPDATE messages SET is_starred = ?, is_archived = ?, is_deleted = ?,
        deleted_at = ?, updated_at = ?
      WHERE mailbox_id = ? AND id = ?
    `).bind(
      after.isStarred ? 1 : 0, after.isArchived ? 1 : 0, after.isDeleted ? 1 : 0,
      after.deletedAt, now, mailboxId, messageId,
    ));
  }
  for (const labelId of actions.labelIds) {
    if (before.labelIds.includes(labelId)) continue;
    statements.push(db.prepare(`
      INSERT INTO message_labels (
        message_id, mailbox_id, label_id, source_rule_id, applied_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, NULL, ?)
      ON CONFLICT(message_id, label_id) DO NOTHING
    `).bind(messageId, mailboxId, labelId, ruleId, now));
  }
  return statements;
}

export function restoreStatements(
  db: D1Database,
  mailboxId: string,
  messageId: string,
  ruleId: string,
  before: RuleMessageState,
  applied: RuleMessageState,
  actions: MailRuleActions,
  now: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (actions.star || actions.archive || actions.trash) {
    statements.push(db.prepare(`
      UPDATE messages SET
        is_starred = CASE WHEN is_starred = ? THEN ? ELSE is_starred END,
        is_archived = CASE WHEN is_archived = ? THEN ? ELSE is_archived END,
        is_deleted = CASE WHEN is_deleted = ? AND deleted_at IS ? THEN ? ELSE is_deleted END,
        deleted_at = CASE WHEN is_deleted = ? AND deleted_at IS ? THEN ? ELSE deleted_at END,
        updated_at = ?
      WHERE mailbox_id = ? AND id = ?
    `).bind(
      applied.isStarred ? 1 : 0, before.isStarred ? 1 : 0,
      applied.isArchived ? 1 : 0, before.isArchived ? 1 : 0,
      applied.isDeleted ? 1 : 0, applied.deletedAt, before.isDeleted ? 1 : 0,
      applied.isDeleted ? 1 : 0, applied.deletedAt, before.deletedAt,
      now, mailboxId, messageId,
    ));
  }
  for (const labelId of actions.labelIds) {
    if (before.labelIds.includes(labelId)) continue;
    statements.push(db.prepare(`
      DELETE FROM message_labels
      WHERE mailbox_id = ? AND message_id = ? AND label_id = ? AND source_rule_id = ?
    `).bind(mailboxId, messageId, labelId, ruleId));
  }
  return statements;
}

export function stateAfterActions(
  before: RuleMessageState,
  actions: MailRuleActions,
  now: number,
): RuleMessageState {
  return {
    isStarred: actions.star || before.isStarred,
    isArchived: actions.trash ? false : actions.archive || before.isArchived,
    isDeleted: actions.archive ? false : actions.trash || before.isDeleted,
    deletedAt: actions.archive ? null : actions.trash
      ? before.deletedAt ?? now
      : before.deletedAt,
    labelIds: [...new Set([...before.labelIds, ...actions.labelIds])].sort(),
  };
}

export function optimisticRestore(
  current: RuleMessageState,
  before: RuleMessageState,
  applied: RuleMessageState,
  actions: MailRuleActions,
  sourcedLabels: Set<string>,
): RuleMessageState {
  const removable = new Set(actions.labelIds.filter((id) => !before.labelIds.includes(id)));
  const deletionUnchanged = current.isDeleted === applied.isDeleted
    && current.deletedAt === applied.deletedAt;
  return {
    isStarred: current.isStarred === applied.isStarred ? before.isStarred : current.isStarred,
    isArchived: current.isArchived === applied.isArchived ? before.isArchived : current.isArchived,
    isDeleted: deletionUnchanged ? before.isDeleted : current.isDeleted,
    deletedAt: deletionUnchanged ? before.deletedAt : current.deletedAt,
    labelIds: current.labelIds.filter((id) => !removable.has(id) || !sourcedLabels.has(id)),
  };
}

export async function ruleSourcedLabelIds(
  db: D1Database,
  mailboxId: string,
  messageId: string,
  ruleId: string,
): Promise<Set<string>> {
  const rows = await db.prepare(`
    SELECT label_id FROM message_labels
    WHERE mailbox_id = ? AND message_id = ? AND source_rule_id = ?
  `).bind(mailboxId, messageId, ruleId).all<{ label_id: string }>();
  return new Set(rows.results.map((row) => row.label_id));
}

export async function processedMessageIds(db: D1Database, runId: string): Promise<Set<string>> {
  const rows = await db.prepare(
    'SELECT message_id FROM mail_rule_run_matches WHERE run_id = ?',
  ).bind(runId).all<{ message_id: string }>();
  return new Set(rows.results.map((row) => row.message_id));
}

export function parseRuleMessageState(raw: string): RuleMessageState {
  return JSON.parse(raw) as RuleMessageState;
}

export function sameRuleMessageState(left: RuleMessageState, right: RuleMessageState): boolean {
  return left.isStarred === right.isStarred
    && left.isArchived === right.isArchived
    && left.isDeleted === right.isDeleted
    && left.deletedAt === right.deletedAt
    && left.labelIds.join('\0') === right.labelIds.join('\0');
}
