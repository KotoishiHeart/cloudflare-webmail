import type {
  MailRuleRun,
  MailRuleRunMatch,
  MailRuleRunMode,
  MailRuleRunStatus,
} from './mail-rule-run-domain.js';
import { normalizeId } from './validation.js';

type RunRow = {
  id: string;
  mailbox_id: string;
  rule_id: string;
  rule_name: string;
  rule_version: number;
  mode: MailRuleRunMode;
  status: MailRuleRunStatus;
  conditions_json: string;
  actions_json: string;
  source_run_id: string | null;
  target_message_id: string | null;
  matched_count: number;
  changed_count: number;
  summary: string;
  created_at: number;
  completed_at: number | null;
};

export async function listMailboxRuleRuns(
  db: D1Database,
  mailboxIdInput: string,
  limitInput = 30,
): Promise<MailRuleRun[]> {
  const limit = Math.max(1, Math.min(50, Math.trunc(limitInput)));
  const rows = await db.prepare(`${RUN_SELECT}
    WHERE mailbox_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
  `).bind(normalizeId(mailboxIdInput, 'mailboxId'), limit).all<RunRow>();
  return rows.results.map(toRun);
}

export async function getMailboxRuleRun(
  db: D1Database,
  mailboxIdInput: string,
  runIdInput: string,
): Promise<MailRuleRun | null> {
  const row = await db.prepare(`${RUN_SELECT} WHERE mailbox_id = ? AND id = ?`).bind(
    normalizeId(mailboxIdInput, 'mailboxId'),
    normalizeId(runIdInput, 'runId'),
  ).first<RunRow>();
  return row === null ? null : toRun(row);
}

export async function listMailboxRuleRunMatches(
  db: D1Database,
  mailboxIdInput: string,
  runIdInput: string,
  limitInput = 80,
): Promise<MailRuleRunMatch[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(limitInput)));
  const result = await db.prepare(`
    SELECT m.id, m.subject, m.sender, m.received_at, m.raw_size, m.attachment_count
    FROM mail_rule_run_matches AS match
    JOIN messages AS m
      ON m.id = match.message_id AND m.mailbox_id = match.mailbox_id
    WHERE match.mailbox_id = ? AND match.run_id = ?
    ORDER BY m.received_at DESC, m.id DESC LIMIT ?
  `).bind(
    normalizeId(mailboxIdInput, 'mailboxId'),
    normalizeId(runIdInput, 'runId'),
    limit,
  ).all<{
    id: string;
    subject: string;
    sender: string;
    received_at: number;
    raw_size: number;
    attachment_count: number;
  }>();
  return result.results.map((row) => ({
    messageId: row.id,
    subject: row.subject,
    sender: row.sender,
    receivedAt: row.received_at,
    rawSize: row.raw_size,
    attachmentCount: row.attachment_count,
  }));
}

export async function getRuleRunBySource(
  db: D1Database,
  mailboxId: string,
  sourceRunId: string,
  mode: 'apply_existing' | 'undo',
): Promise<MailRuleRun | null> {
  const row = await db.prepare(`${RUN_SELECT}
    WHERE mailbox_id = ? AND source_run_id = ? AND mode = ? LIMIT 1
  `).bind(mailboxId, sourceRunId, mode).first<RunRow>();
  return row === null ? null : toRun(row);
}

export async function createDerivedRuleRun(
  db: D1Database,
  input: {
    id: string;
    source: MailRuleRun;
    mode: 'apply_existing' | 'undo';
    userId: string;
    now: number;
  },
): Promise<MailRuleRun> {
  await db.prepare(`
    INSERT INTO mail_rule_runs (
      id, mailbox_id, rule_id, rule_name, rule_version, mode, status,
      conditions_json, actions_json, source_run_id, matched_count, summary,
      created_by_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.id, input.source.mailboxId, input.source.ruleId, input.source.ruleName,
    input.source.ruleVersion, input.mode, JSON.stringify(input.source.conditions),
    JSON.stringify(input.source.actions), input.source.id, input.source.matchedCount,
    `${input.source.id} から${input.mode === 'undo' ? '取り消し' : '一括適用'}`,
    input.userId, input.now,
  ).run();
  return requireMailboxRuleRun(db, input.source.mailboxId, input.id);
}

export async function listRuleRunMessageIds(db: D1Database, runId: string): Promise<string[]> {
  const rows = await db.prepare(`
    SELECT message_id FROM mail_rule_run_matches WHERE run_id = ? ORDER BY created_at, message_id
  `).bind(runId).all<{ message_id: string }>();
  return rows.results.map((row) => row.message_id);
}

export async function ruleRunMatchCount(
  db: D1Database,
  runId: string,
  changedOnly = false,
): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count FROM mail_rule_run_matches
    WHERE run_id = ? ${changedOnly ? 'AND before_json <> after_json' : ''}
  `).bind(runId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function requireMailboxRuleRun(
  db: D1Database,
  mailboxId: string,
  runId: string,
): Promise<MailRuleRun> {
  const run = await getMailboxRuleRun(db, mailboxId, runId);
  if (run === null) throw new Error('mail rule run became unavailable');
  return run;
}

const RUN_SELECT = `SELECT id, mailbox_id, rule_id, rule_name, rule_version, mode, status,
  conditions_json, actions_json, source_run_id, target_message_id, matched_count,
  changed_count, summary, created_at, completed_at FROM mail_rule_runs`;

function toRun(row: RunRow): MailRuleRun {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    ruleVersion: row.rule_version,
    mode: row.mode,
    status: row.status,
    conditions: JSON.parse(row.conditions_json),
    actions: JSON.parse(row.actions_json),
    sourceRunId: row.source_run_id,
    targetMessageId: row.target_message_id,
    matchedCount: row.matched_count,
    changedCount: row.changed_count,
    summary: row.summary,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}
