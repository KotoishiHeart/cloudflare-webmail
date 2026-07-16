import type { RetentionRun, RetentionRunItem } from './retention-domain.js';
import { getRetentionPolicy } from './retention-policies.js';
import { DatabaseInputError, normalizeId, requireTimestamp } from './validation.js';

type CandidateRow = {
  id: string;
  subject: string;
  received_at: number;
  deleted_at: number;
  raw_size: number;
  raw_key: string;
  body_text_key: string | null;
  body_html_key: string | null;
  attachment_keys_json: string;
};

export async function createRetentionPreview(
  db: D1Database,
  input: { mailboxId: string; userId: string; limit: number; now: number },
): Promise<{ status: 'created'; run: RetentionRun } | { status: 'disabled' | 'active-run' | 'not-found' }> {
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  const userId = normalizeId(input.userId, 'userId');
  const now = requireTimestamp(input.now);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
    throw new DatabaseInputError('limit', 'must be between 1 and 200');
  }
  const policy = await getRetentionPolicy(db, mailboxId);
  if (policy === null) return { status: 'not-found' };
  if (!policy.enabled) return { status: 'disabled' };
  const active = await db.prepare(`
    SELECT 1 AS found FROM retention_runs
    WHERE mailbox_id = ? AND status IN ('building', 'preview', 'approved', 'running') LIMIT 1
  `).bind(mailboxId).first();
  if (active !== null) return { status: 'active-run' };

  const runId = crypto.randomUUID();
  const cutoff = now - policy.retentionDays * 86_400_000;
  await db.prepare(`
    INSERT INTO retention_runs (
      id, mailbox_id, status, cutoff_at, retention_days,
      exclude_starred, exclude_labeled, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, 'building', ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    runId, mailboxId, cutoff, policy.retentionDays,
    policy.excludeStarred ? 1 : 0, policy.excludeLabeled ? 1 : 0,
    userId, now, now,
  ).run();

  try {
    const candidates = await selectCandidates(db, {
      mailboxId,
      cutoff,
      excludeStarred: policy.excludeStarred,
      excludeLabeled: policy.excludeLabeled,
      limit: input.limit,
    });
    const statements = candidates.map((candidate) => db.prepare(`
      INSERT INTO retention_run_items (
        run_id, message_id, subject_snapshot, received_at, deleted_at, bytes,
        object_keys_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      runId, candidate.id, candidate.subject, candidate.received_at,
      candidate.deleted_at, candidate.raw_size,
      JSON.stringify(objectKeys(candidate)), now, now,
    ));
    for (let index = 0; index < statements.length; index += 50) {
      await db.batch(statements.slice(index, index + 50));
    }
    const bytes = candidates.reduce((sum, candidate) => sum + candidate.raw_size, 0);
    await db.prepare(`
      UPDATE retention_runs
      SET status = 'preview', candidate_count = ?, candidate_bytes = ?, updated_at = ?
      WHERE id = ? AND status = 'building'
    `).bind(candidates.length, bytes, now, runId).run();
  } catch (error) {
    await db.prepare(`
      UPDATE retention_runs SET status = 'failed', error_summary = ?,
        completed_at = ?, updated_at = ? WHERE id = ?
    `).bind(errorSummary(error), now, now, runId).run();
    throw error;
  }
  const run = await getRetentionRun(db, runId);
  if (run === null) throw new Error('retention preview became unavailable');
  return { status: 'created', run };
}

export async function listRetentionRuns(
  db: D1Database,
  mailboxIdInput?: string,
  limit = 50,
): Promise<RetentionRun[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new DatabaseInputError('limit', 'must be between 1 and 100');
  }
  const mailboxId = mailboxIdInput === undefined
    ? undefined
    : normalizeId(mailboxIdInput, 'mailboxId');
  const statement = mailboxId === undefined
    ? db.prepare('SELECT * FROM retention_runs ORDER BY created_at DESC, id DESC LIMIT ?').bind(limit)
    : db.prepare(`
      SELECT * FROM retention_runs WHERE mailbox_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).bind(mailboxId, limit);
  const result = await statement.all<RetentionRunRow>();
  return result.results.map(toRun);
}

export async function getRetentionRun(
  db: D1Database,
  runIdInput: string,
): Promise<RetentionRun | null> {
  const runId = normalizeId(runIdInput, 'runId');
  const row = await db.prepare('SELECT * FROM retention_runs WHERE id = ?')
    .bind(runId).first<RetentionRunRow>();
  return row === null ? null : toRun(row);
}

export async function getRetentionRunDetail(db: D1Database, runIdInput: string) {
  const run = await getRetentionRun(db, runIdInput);
  if (run === null) return null;
  const result = await db.prepare(`
    SELECT * FROM retention_run_items WHERE run_id = ?
    ORDER BY deleted_at ASC, message_id LIMIT 500
  `).bind(run.id).all<RetentionItemRow>();
  return { run, items: result.results.map(toItem) };
}

async function selectCandidates(
  db: D1Database,
  input: {
    mailboxId: string;
    cutoff: number;
    excludeStarred: boolean;
    excludeLabeled: boolean;
    limit: number;
  },
): Promise<CandidateRow[]> {
  const result = await db.prepare(`
    SELECT m.id, m.subject, m.received_at, m.deleted_at, m.raw_size,
      m.raw_key, m.body_text_key, m.body_html_key,
      COALESCE(
        json_group_array(a.storage_key) FILTER (WHERE a.storage_key IS NOT NULL),
        json('[]')
      ) AS attachment_keys_json
    FROM messages m
    LEFT JOIN attachments a ON a.message_id = m.id
    WHERE m.mailbox_id = ? AND m.is_deleted = 1
      AND m.deleted_at IS NOT NULL AND m.deleted_at <= ?
      AND m.status NOT IN ('queued', 'sending')
      AND (? = 0 OR m.is_starred = 0)
      AND (? = 0 OR NOT EXISTS (
        SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id
      ))
    GROUP BY m.id
    ORDER BY m.deleted_at ASC, m.id ASC LIMIT ?
  `).bind(
    input.mailboxId, input.cutoff, input.excludeStarred ? 1 : 0,
    input.excludeLabeled ? 1 : 0, input.limit,
  ).all<CandidateRow>();
  return result.results;
}

function objectKeys(row: CandidateRow): string[] {
  const attachments = JSON.parse(row.attachment_keys_json) as unknown;
  if (!Array.isArray(attachments) || attachments.some((key) => typeof key !== 'string')) {
    throw new Error('retention attachment key snapshot is invalid');
  }
  return [...new Set([
    row.raw_key,
    ...(row.body_text_key === null ? [] : [row.body_text_key]),
    ...(row.body_html_key === null ? [] : [row.body_html_key]),
    ...attachments,
  ])];
}

type RetentionRunRow = {
  id: string; mailbox_id: string; status: RetentionRun['status']; cutoff_at: number;
  retention_days: number; exclude_starred: number; exclude_labeled: number;
  candidate_count: number; candidate_bytes: number; completed_count: number;
  skipped_count: number; failed_count: number; backup_reference: string;
  backup_manifest_sha256: string; backup_created_at: number | null; error_summary: string;
  created_at: number; approved_at: number | null; started_at: number | null;
  completed_at: number | null; updated_at: number;
};

function toRun(row: RetentionRunRow): RetentionRun {
  return {
    id: row.id, mailboxId: row.mailbox_id, status: row.status, cutoffAt: row.cutoff_at,
    retentionDays: row.retention_days, excludeStarred: row.exclude_starred === 1,
    excludeLabeled: row.exclude_labeled === 1, candidateCount: row.candidate_count,
    candidateBytes: row.candidate_bytes, completedCount: row.completed_count,
    skippedCount: row.skipped_count, failedCount: row.failed_count,
    backupReference: row.backup_reference,
    backupManifestSha256: row.backup_manifest_sha256,
    backupCreatedAt: row.backup_created_at, errorSummary: row.error_summary,
    createdAt: row.created_at, approvedAt: row.approved_at, startedAt: row.started_at,
    completedAt: row.completed_at, updatedAt: row.updated_at,
  };
}

type RetentionItemRow = {
  run_id: string; message_id: string; status: RetentionRunItem['status'];
  subject_snapshot: string; received_at: number; deleted_at: number; bytes: number;
  object_keys_json: string; next_object_index: number; attempts: number;
  d1_deleted_at: number | null; error_summary: string; created_at: number; updated_at: number;
};

function toItem(row: RetentionItemRow): RetentionRunItem {
  return {
    runId: row.run_id, messageId: row.message_id, status: row.status,
    subjectSnapshot: row.subject_snapshot, receivedAt: row.received_at,
    deletedAt: row.deleted_at, bytes: row.bytes,
    objectKeys: JSON.parse(row.object_keys_json) as string[],
    nextObjectIndex: row.next_object_index, attempts: row.attempts,
    d1DeletedAt: row.d1_deleted_at, errorSummary: row.error_summary,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function errorSummary(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
