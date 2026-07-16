import { applyMailRuleActions, undoMailRuleActions } from './mail-rule-actions.js';
import type { MailRule } from './mail-rule-domain.js';
import { listMailRuleMatches } from './mail-rule-matching.js';
import {
  createDerivedRuleRun,
  getMailboxRuleRun,
  getRuleRunBySource,
  listRuleRunMessageIds,
  requireMailboxRuleRun,
  ruleRunMatchCount,
} from './mail-rule-runs.js';
import type { MailRuleRun } from './mail-rule-run-domain.js';
import { getMailboxRule } from './mail-rules.js';
import { normalizeId, requireTimestamp } from './validation.js';

export async function previewMailboxRule(
  db: D1Database,
  input: { runId: string; rule: MailRule; userId: string; now: number },
): Promise<MailRuleRun> {
  const runId = normalizeId(input.runId, 'runId');
  const userId = normalizeId(input.userId, 'userId');
  const now = requireTimestamp(input.now);
  const matches = await listMailRuleMatches(db, input.rule.mailboxId, input.rule.conditions, 200);
  const conditionsJson = JSON.stringify(input.rule.conditions);
  const actionsJson = JSON.stringify(input.rule.actions);
  await db.batch([
    db.prepare(`
      INSERT INTO mail_rule_runs (
        id, mailbox_id, rule_id, rule_name, rule_version, mode, status,
        conditions_json, actions_json, matched_count, changed_count, summary,
        created_by_user_id, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, 'preview', 'ready', ?, ?, ?, 0, ?, ?, ?, ?)
    `).bind(
      runId, input.rule.mailboxId, input.rule.id, input.rule.name, input.rule.revision,
      conditionsJson, actionsJson, matches.length, previewSummary(matches.length),
      userId, now, now,
    ),
    ...matches.map((message) => db.prepare(`
      INSERT INTO mail_rule_run_matches (
        run_id, message_id, mailbox_id, action_json, before_json, after_json, created_at
      ) VALUES (?, ?, ?, ?, '{}', '{}', ?)
    `).bind(runId, message.id, input.rule.mailboxId, actionsJson, now)),
    db.prepare(`
      UPDATE mail_rules SET last_preview_count = ?, last_preview_at = ?, updated_at = ?
      WHERE id = ? AND mailbox_id = ?
    `).bind(matches.length, now, now, input.rule.id, input.rule.mailboxId),
  ]);
  return requireMailboxRuleRun(db, input.rule.mailboxId, runId);
}

export async function applyPreviewRuleRun(
  db: D1Database,
  input: { runId: string; previewRunId: string; mailboxId: string; userId: string; now: number },
): Promise<MailRuleRun> {
  const values = runIdentifiers(input, 'previewRunId');
  const preview = await getMailboxRuleRun(db, values.mailboxId, values.sourceRunId);
  if (preview === null || preview.mode !== 'preview') throw new MailRuleRunConflictError('preview_not_found');
  const existing = await getRuleRunBySource(
    db, values.mailboxId, values.sourceRunId, 'apply_existing',
  );
  if (existing?.status === 'completed') return existing;
  const rule = await getMailboxRule(db, values.mailboxId, preview.ruleId);
  if (rule === null) throw new MailRuleRunConflictError('rule_deleted');
  if (!rule.applyExisting) throw new MailRuleRunConflictError('existing_apply_disabled');
  if (rule.revision !== preview.ruleVersion || preview.status !== 'ready') {
    await blockPreview(db, preview.id, values.now);
    throw new MailRuleRunConflictError('stale_preview');
  }
  const run = existing ?? await createDerivedRuleRun(db, {
    id: values.runId, source: preview, mode: 'apply_existing',
    userId: values.userId, now: values.now,
  });
  const messageIds = await listRuleRunMessageIds(db, preview.id);
  await applyMailRuleActions(db, {
    runId: run.id, mailboxId: values.mailboxId, ruleId: rule.id,
    actions: preview.actions, messageIds, now: values.now,
  });
  const changed = await ruleRunMatchCount(db, run.id, true);
  await db.batch([
    db.prepare(`
      UPDATE mail_rule_runs SET status = 'completed', matched_count = ?, changed_count = ?,
        summary = ?, completed_at = ? WHERE id = ?
    `).bind(messageIds.length, changed, `${changed}/${messageIds.length}件を変更`, values.now, run.id),
    db.prepare("UPDATE mail_rule_runs SET status = 'applied' WHERE id = ? AND status = 'ready'")
      .bind(preview.id),
    db.prepare('UPDATE mail_rules SET last_run_at = ?, updated_at = ? WHERE id = ?')
      .bind(values.now, values.now, rule.id),
  ]);
  return requireMailboxRuleRun(db, values.mailboxId, run.id);
}

export async function undoAppliedRuleRun(
  db: D1Database,
  input: { runId: string; sourceRunId: string; mailboxId: string; userId: string; now: number },
): Promise<MailRuleRun> {
  const values = runIdentifiers(input, 'sourceRunId');
  const source = await getMailboxRuleRun(db, values.mailboxId, values.sourceRunId);
  if (source === null || !['apply_existing', 'incoming'].includes(source.mode)) {
    throw new MailRuleRunConflictError('run_not_undoable');
  }
  const existing = await getRuleRunBySource(db, values.mailboxId, source.id, 'undo');
  if (existing?.status === 'completed') return existing;
  if (source.status !== 'completed') throw new MailRuleRunConflictError('run_not_undoable');
  const run = existing ?? await createDerivedRuleRun(db, {
    id: values.runId, source, mode: 'undo', userId: values.userId, now: values.now,
  });
  await undoMailRuleActions(db, {
    sourceRunId: source.id, undoRunId: run.id, mailboxId: values.mailboxId,
    ruleId: source.ruleId, now: values.now,
  });
  const changed = await ruleRunMatchCount(db, run.id, true);
  const matched = await ruleRunMatchCount(db, run.id);
  await db.batch([
    db.prepare(`
      UPDATE mail_rule_runs SET status = 'completed', matched_count = ?, changed_count = ?,
        summary = ?, completed_at = ? WHERE id = ?
    `).bind(matched, changed, `${changed}/${matched}件を安全に復元`, values.now, run.id),
    db.prepare("UPDATE mail_rule_runs SET status = 'undone' WHERE id = ? AND status = 'completed'")
      .bind(source.id),
  ]);
  return requireMailboxRuleRun(db, values.mailboxId, run.id);
}

export class MailRuleRunConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MailRuleRunConflictError';
  }
}

function runIdentifiers(
  input: { runId: string; mailboxId: string; userId: string; now: number } & Record<string, unknown>,
  sourceField: string,
) {
  return {
    runId: normalizeId(input.runId, 'runId'),
    sourceRunId: normalizeId(String(input[sourceField]), sourceField),
    mailboxId: normalizeId(input.mailboxId, 'mailboxId'),
    userId: normalizeId(input.userId, 'userId'),
    now: requireTimestamp(input.now),
  };
}

async function blockPreview(db: D1Database, runId: string, now: number): Promise<void> {
  await db.prepare(`
    UPDATE mail_rule_runs SET status = 'blocked',
      summary = 'ルール変更後の古いプレビューは適用できません。', completed_at = ?
    WHERE id = ?
  `).bind(now, runId).run();
}

function previewSummary(count: number): string {
  return count === 200 ? '200件をプレビュー（上限到達）' : `${count}件をプレビュー`;
}
