import type { MailRuleActions } from './mail-rule-domain.js';
import {
  actionStatements,
  getRuleMessageState,
  optimisticRestore,
  parseRuleMessageState,
  processedMessageIds,
  restoreStatements,
  ruleSourcedLabelIds,
  sameRuleMessageState,
  stateAfterActions,
  type StoredRuleRunMatch,
} from './mail-rule-action-state.js';
import { normalizeId, requireTimestamp } from './validation.js';

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
    const after = stateAfterActions(before, input.actions, now);
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
    if (!sameRuleMessageState(before, after)) changed += 1;
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
  `).bind(sourceRunId).all<StoredRuleRunMatch>();
  const processed = await processedMessageIds(db, undoRunId);
  let changed = 0;
  for (const row of rows.results) {
    if (processed.has(row.message_id)) continue;
    const before = parseRuleMessageState(row.before_json);
    const applied = parseRuleMessageState(row.after_json);
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
    if (!sameRuleMessageState(current, restored)) changed += 1;
  }
  return changed;
}
