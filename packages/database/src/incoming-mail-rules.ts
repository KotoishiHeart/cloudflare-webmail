import { applyMailRuleActions } from './mail-rule-actions.js';
import { listMailRuleMatches } from './mail-rule-matching.js';
import { getMailboxRuleRun } from './mail-rule-runs.js';
import { listIncomingMailboxRules } from './mail-rules.js';
import { normalizeId, requireTimestamp } from './validation.js';

export type IncomingMailRuleResult = {
  evaluated: number;
  matched: number;
  changed: number;
  stopped: boolean;
  failed: boolean;
};

export async function applyIncomingMailRulesSafely(
  db: D1Database,
  mailboxIdInput: string,
  messageIdInput: string,
  nowInput: number,
): Promise<IncomingMailRuleResult> {
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const messageId = normalizeId(messageIdInput, 'messageId');
  const now = requireTimestamp(nowInput);
  const result: IncomingMailRuleResult = {
    evaluated: 0,
    matched: 0,
    changed: 0,
    stopped: false,
    failed: false,
  };
  try {
    const rules = await listIncomingMailboxRules(db, mailboxId);
    for (const rule of rules) {
      result.evaluated += 1;
      const matches = await listMailRuleMatches(
        db, mailboxId, rule.conditions, 1, messageId,
      );
      if (matches.length === 0) continue;
      result.matched += 1;
      const run = await getOrCreateIncomingRun(db, {
        runId: crypto.randomUUID(), mailboxId, messageId, now, rule,
      });
      if (!['completed', 'undone'].includes(run.status)) {
        await applyMailRuleActions(db, {
          runId: run.id,
          mailboxId,
          messageIds: [messageId],
          ruleId: rule.id,
          actions: rule.actions,
          now,
        });
        const changed = await changedCount(db, run.id);
        await db.batch([
          db.prepare(`
            UPDATE mail_rule_runs SET status = 'completed', matched_count = 1,
              changed_count = ?, summary = ?, completed_at = ? WHERE id = ?
          `).bind(changed, changed === 1 ? '新規受信メールを変更' : '一致（変更なし）', now, run.id),
          db.prepare('UPDATE mail_rules SET last_run_at = ?, updated_at = ? WHERE id = ?')
            .bind(now, now, rule.id),
        ]);
        result.changed += changed;
      }
      if (rule.stopProcessing) {
        result.stopped = true;
        break;
      }
    }
  } catch (error) {
    result.failed = true;
    console.error(JSON.stringify({
      event: 'inbound.rules_failed',
      mailboxId,
      messageId,
      errorType: error instanceof Error ? error.name : typeof error,
    }));
  }
  return result;
}

async function getOrCreateIncomingRun(
  db: D1Database,
  input: {
    runId: string;
    mailboxId: string;
    messageId: string;
    now: number;
    rule: Awaited<ReturnType<typeof listIncomingMailboxRules>>[number];
  },
) {
  const insert = await db.prepare(`
    INSERT INTO mail_rule_runs (
      id, mailbox_id, rule_id, rule_name, rule_version, mode, status,
      conditions_json, actions_json, target_message_id, matched_count,
      summary, created_at
    ) VALUES (?, ?, ?, ?, ?, 'incoming', 'running', ?, ?, ?, 1, ?, ?)
    ON CONFLICT DO NOTHING
  `).bind(
    input.runId, input.mailboxId, input.rule.id, input.rule.name, input.rule.revision,
    JSON.stringify(input.rule.conditions), JSON.stringify(input.rule.actions), input.messageId,
    '新規受信ルールを適用中', input.now,
  ).run();
  if (Number(insert.meta.changes ?? 0) === 1) {
    const created = await getMailboxRuleRun(db, input.mailboxId, input.runId);
    if (created === null) throw new Error('incoming rule run became unavailable');
    return created;
  }
  const row = await db.prepare(`
    SELECT id FROM mail_rule_runs
    WHERE mailbox_id = ? AND rule_id = ? AND target_message_id = ? AND mode = 'incoming'
    LIMIT 1
  `).bind(input.mailboxId, input.rule.id, input.messageId).first<{ id: string }>();
  if (row === null) throw new Error('incoming rule run conflict could not be resolved');
  const existing = await getMailboxRuleRun(db, input.mailboxId, row.id);
  if (existing === null) throw new Error('incoming rule run became unavailable');
  return existing;
}

async function changedCount(db: D1Database, runId: string): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count FROM mail_rule_run_matches
    WHERE run_id = ? AND before_json <> after_json
  `).bind(runId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}
