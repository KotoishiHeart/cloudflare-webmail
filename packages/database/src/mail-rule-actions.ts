import type { MailRuleActions } from './mail-rule-domain.js';
import type { RuleMessageState } from './mail-rule-run-domain.js';
import { normalizeId, requireTimestamp } from './validation.js';

type StoredRunMatch = {
  message_id: string;
  action_json: string;
  before_json: string;
  after_json: string;
};

export async function applyMailRuleActions(
  db: D1Database,
  input: {
    runId: string;
    mailboxId: string;
    ruleId: string;
    actions: MailRuleActions;
    messageIds: string[];
    now: number;
  },
): Promise<number> {
  const runId = normalizeId(input.runId, 'runId');
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  const ruleId = normalizeId(input.ruleId, 'ruleId');
  const now = requireTimestamp(input.now);
  const processed = await processedMessageIds(db, runId);
  let changed = 0;
  for (const messageIdInput of [...new Set(input.messageIds)]) {
    const messageId = normalizeId(messageIdInput, 'messageId');
    if (processed.has(messageId)) continue;
    const before = await getRuleMessageState(db, mailboxId, messageId);
    if (before === null) continue;
    const after = stateAfterActions(before, input.actions);
    const statements = actionStatements(
      db, mailboxId, messageId, ruleId, input.actions, before, after, now,
    );
    statements.push(db.prepare(`
      INSERT INTO mail_rule_run_matches (
        run_id, message_id, mailbox_id, action_json, before_json, after_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, message_id) DO NOTHING
    `).bind(
      runId, messageId, mailboxId, JSON.stringify(input.actions),
      JSON.stringify(before), JSON.stringify(after), now,
    ));
    await db.batch(statements);
    if (!sameState(before, after)) changed += 1;
  }
  return changed;
}

export async function undoMailRuleActions(
  db: D1Database,
  input: {
    sourceRunId: string;
    undoRunId: string;
    mailboxId: string;
    ruleId: string;
    now: number;
  },
): Promise<number> {
  const sourceRunId = normalizeId(input.sourceRunId, 'sourceRunId');
  const undoRunId = normalizeId(input.undoRunId, 'undoRunId');
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  const ruleId = normalizeId(input.ruleId, 'ruleId');
  const now = requireTimestamp(input.now);
  const rows = await db.prepare(`
    SELECT message_id, action_json, before_json, after_json
    FROM mail_rule_run_matches WHERE run_id = ? ORDER BY created_at DESC
  `).bind(sourceRunId).all<StoredRunMatch>();
  const processed = await processedMessageIds(db, undoRunId);
  let changed = 0;
  for (const row of rows.results) {
    if (processed.has(row.message_id)) continue;
    const before = parseState(row.before_json);
    const applied = parseState(row.after_json);
    const actions = JSON.parse(row.action_json) as MailRuleActions;
    const current = await getRuleMessageState(db, mailboxId, row.message_id);
    if (current === null) continue;
    const sourcedLabels = await ruleSourcedLabelIds(
      db, mailboxId, row.message_id, ruleId,
    );
    const restored = optimisticRestore(current, before, applied, actions, sourcedLabels);
    const statements = restoreStatements(
      db, mailboxId, row.message_id, ruleId, before, applied, actions, now,
    );
    statements.push(db.prepare(`
      INSERT INTO mail_rule_run_matches (
        run_id, message_id, mailbox_id, action_json, before_json, after_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, message_id) DO NOTHING
    `).bind(
      undoRunId, row.message_id, mailboxId, row.action_json,
      JSON.stringify(current), JSON.stringify(restored), now,
    ));
    await db.batch(statements);
    if (!sameState(current, restored)) changed += 1;
  }
  return changed;
}

async function getRuleMessageState(
  db: D1Database,
  mailboxId: string,
  messageId: string,
): Promise<RuleMessageState | null> {
  const row = await db.prepare(`
    SELECT is_starred, is_archived, is_deleted FROM messages
    WHERE mailbox_id = ? AND id = ?
  `).bind(mailboxId, messageId).first<{
    is_starred: number;
    is_archived: number;
    is_deleted: number;
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
    labelIds: labels.results.map((label) => label.label_id),
  };
}

function actionStatements(
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
      UPDATE messages SET is_starred = ?, is_archived = ?, is_deleted = ?, updated_at = ?
      WHERE mailbox_id = ? AND id = ?
    `).bind(
      after.isStarred ? 1 : 0, after.isArchived ? 1 : 0, after.isDeleted ? 1 : 0,
      now, mailboxId, messageId,
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

function restoreStatements(
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
        is_deleted = CASE WHEN is_deleted = ? THEN ? ELSE is_deleted END,
        updated_at = ?
      WHERE mailbox_id = ? AND id = ?
    `).bind(
      applied.isStarred ? 1 : 0, before.isStarred ? 1 : 0,
      applied.isArchived ? 1 : 0, before.isArchived ? 1 : 0,
      applied.isDeleted ? 1 : 0, before.isDeleted ? 1 : 0,
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

function stateAfterActions(before: RuleMessageState, actions: MailRuleActions): RuleMessageState {
  return {
    isStarred: actions.star || before.isStarred,
    isArchived: actions.trash ? false : actions.archive || before.isArchived,
    isDeleted: actions.archive ? false : actions.trash || before.isDeleted,
    labelIds: [...new Set([...before.labelIds, ...actions.labelIds])].sort(),
  };
}

function optimisticRestore(
  current: RuleMessageState,
  before: RuleMessageState,
  applied: RuleMessageState,
  actions: MailRuleActions,
  sourcedLabels: Set<string>,
): RuleMessageState {
  const removable = new Set(actions.labelIds.filter((id) => !before.labelIds.includes(id)));
  return {
    isStarred: current.isStarred === applied.isStarred ? before.isStarred : current.isStarred,
    isArchived: current.isArchived === applied.isArchived ? before.isArchived : current.isArchived,
    isDeleted: current.isDeleted === applied.isDeleted ? before.isDeleted : current.isDeleted,
    labelIds: current.labelIds.filter((id) => !removable.has(id) || !sourcedLabels.has(id)),
  };
}

async function ruleSourcedLabelIds(
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

async function processedMessageIds(db: D1Database, runId: string): Promise<Set<string>> {
  const rows = await db.prepare(
    'SELECT message_id FROM mail_rule_run_matches WHERE run_id = ?',
  ).bind(runId).all<{ message_id: string }>();
  return new Set(rows.results.map((row) => row.message_id));
}

function parseState(raw: string): RuleMessageState {
  return JSON.parse(raw) as RuleMessageState;
}

function sameState(left: RuleMessageState, right: RuleMessageState): boolean {
  return left.isStarred === right.isStarred
    && left.isArchived === right.isArchived
    && left.isDeleted === right.isDeleted
    && left.labelIds.join('\0') === right.labelIds.join('\0');
}
