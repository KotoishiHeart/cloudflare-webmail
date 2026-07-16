import type { RetentionRunItem } from './retention-domain.js';
import { DatabaseInputError, requireTimestamp } from './validation.js';

export type RetentionWorkItem = RetentionRunItem & {
  mailboxId: string;
  cutoffAt: number;
  excludeStarred: boolean;
  excludeLabeled: boolean;
  leaseOwner: string;
};

export async function claimRetentionWork(
  db: D1Database,
  input: { leaseOwner: string; now: number },
): Promise<RetentionWorkItem | null> {
  const now = requireTimestamp(input.now);
  const leaseOwner = boundedRequired(input.leaseOwner, 'leaseOwner', 128);
  await db.prepare(`
    UPDATE retention_runs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
    WHERE id = (
      SELECT id FROM retention_runs WHERE status = 'approved'
      ORDER BY approved_at, id LIMIT 1
    ) AND status = 'approved'
  `).bind(now, now).run();
  const candidate = await db.prepare(`
    SELECT i.run_id, i.message_id
    FROM retention_run_items i
    JOIN retention_runs r ON r.id = i.run_id AND r.status = 'running'
    WHERE i.status IN ('candidate', 'd1_deleted')
      AND (i.lease_owner = '' OR i.lease_expires_at IS NULL OR i.lease_expires_at < ?)
    ORDER BY r.started_at, i.deleted_at, i.message_id LIMIT 1
  `).bind(now).first<{ run_id: string; message_id: string }>();
  if (candidate === null) {
    await finalizeRetentionRuns(db, now);
    return null;
  }
  const claimed = await db.prepare(`
    UPDATE retention_run_items
    SET lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
    WHERE run_id = ? AND message_id = ? AND status IN ('candidate', 'd1_deleted')
      AND (lease_owner = '' OR lease_expires_at IS NULL OR lease_expires_at < ?)
  `).bind(
    leaseOwner, now + 120_000, now,
    candidate.run_id, candidate.message_id, now,
  ).run();
  if (claimed.meta.changes !== 1) return null;
  return readClaimedWork(db, candidate.run_id, candidate.message_id, leaseOwner);
}

export async function deleteRetentionMetadata(
  db: D1Database,
  work: RetentionWorkItem,
  nowInput: number,
): Promise<'d1-deleted' | 'skipped'> {
  const now = requireTimestamp(nowInput);
  const deleteResult = await db.batch([
    db.prepare(`
      DELETE FROM messages
      WHERE id = ? AND mailbox_id = ? AND is_deleted = 1
        AND deleted_at IS NOT NULL AND deleted_at <= ?
        AND status NOT IN ('queued', 'sending')
        AND (? = 0 OR is_starred = 0)
        AND (? = 0 OR NOT EXISTS (
          SELECT 1 FROM message_labels ml WHERE ml.message_id = messages.id
        ))
    `).bind(
      work.messageId, work.mailboxId, work.cutoffAt,
      work.excludeStarred ? 1 : 0, work.excludeLabeled ? 1 : 0,
    ),
    db.prepare(`
      UPDATE retention_run_items
      SET status = CASE
          WHEN EXISTS(SELECT 1 FROM messages WHERE id = ?) THEN 'skipped'
          ELSE 'd1_deleted'
        END,
        d1_deleted_at = CASE
          WHEN EXISTS(SELECT 1 FROM messages WHERE id = ?) THEN NULL ELSE ?
        END,
        lease_owner = CASE
          WHEN EXISTS(SELECT 1 FROM messages WHERE id = ?) THEN '' ELSE lease_owner
        END,
        lease_expires_at = CASE
          WHEN EXISTS(SELECT 1 FROM messages WHERE id = ?) THEN NULL ELSE lease_expires_at
        END,
        error_summary = '', updated_at = ?
      WHERE run_id = ? AND message_id = ? AND lease_owner = ? AND status = 'candidate'
    `).bind(
      work.messageId, work.messageId, now, work.messageId, work.messageId,
      now, work.runId, work.messageId, work.leaseOwner,
    ),
  ]);
  if (deleteResult[1]?.meta.changes !== 1) {
    throw new Error('retention metadata claim was lost');
  }
  if (deleteResult[0]?.meta.changes === 1) return 'd1-deleted';
  const state = await db.prepare(`
    SELECT status FROM retention_run_items WHERE run_id = ? AND message_id = ?
  `).bind(work.runId, work.messageId).first<{ status: string }>();
  return state?.status === 'd1_deleted' ? 'd1-deleted' : 'skipped';
}

export async function advanceRetentionObjects(
  db: D1Database,
  input: {
    work: RetentionWorkItem;
    nextObjectIndex: number;
    completed: boolean;
    now: number;
  },
): Promise<void> {
  await db.prepare(`
    UPDATE retention_run_items
    SET status = ?, next_object_index = ?, lease_owner = '', lease_expires_at = NULL,
      error_summary = '', updated_at = ?
    WHERE run_id = ? AND message_id = ? AND lease_owner = ? AND status = 'd1_deleted'
  `).bind(
    input.completed ? 'completed' : 'd1_deleted', input.nextObjectIndex,
    requireTimestamp(input.now), input.work.runId, input.work.messageId, input.work.leaseOwner,
  ).run();
}

export async function unreferencedRetentionObjectKeys(
  db: D1Database,
  keys: string[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  if (keys.length > 20 || keys.some((key) => key === '' || key.length > 1024)) {
    throw new DatabaseInputError('objectKeys', 'contains an invalid retention object chunk');
  }
  const placeholders = keys.map(() => '?').join(', ');
  const result = await db.prepare(`
    SELECT raw_key AS object_key FROM messages WHERE raw_key IN (${placeholders})
    UNION SELECT body_text_key FROM messages WHERE body_text_key IN (${placeholders})
    UNION SELECT body_html_key FROM messages WHERE body_html_key IN (${placeholders})
    UNION SELECT storage_key FROM attachments WHERE storage_key IN (${placeholders})
  `).bind(...keys, ...keys, ...keys, ...keys).all<{ object_key: string }>();
  const referenced = new Set(result.results.map((row) => row.object_key));
  return keys.filter((key) => !referenced.has(key));
}

export async function failRetentionWork(
  db: D1Database,
  work: RetentionWorkItem,
  error: unknown,
  nowInput: number,
): Promise<void> {
  const now = requireTimestamp(nowInput);
  await db.prepare(`
    UPDATE retention_run_items
    SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE status END,
      lease_owner = '', lease_expires_at = NULL, error_summary = ?, updated_at = ?
    WHERE run_id = ? AND message_id = ? AND lease_owner = ?
  `).bind(
    errorSummary(error), now, work.runId, work.messageId, work.leaseOwner,
  ).run();
}

export async function finalizeRetentionRuns(db: D1Database, nowInput: number): Promise<void> {
  const now = requireTimestamp(nowInput);
  await db.prepare(`
    UPDATE retention_runs
    SET status = CASE
        WHEN EXISTS(SELECT 1 FROM retention_run_items i
          WHERE i.run_id = retention_runs.id AND i.status = 'failed') THEN 'failed'
        ELSE 'completed'
      END,
      completed_count = (SELECT COUNT(*) FROM retention_run_items i
        WHERE i.run_id = retention_runs.id AND i.status = 'completed'),
      skipped_count = (SELECT COUNT(*) FROM retention_run_items i
        WHERE i.run_id = retention_runs.id AND i.status = 'skipped'),
      failed_count = (SELECT COUNT(*) FROM retention_run_items i
        WHERE i.run_id = retention_runs.id AND i.status = 'failed'),
      completed_at = ?, updated_at = ?
    WHERE status = 'running'
      AND NOT EXISTS(SELECT 1 FROM retention_run_items i
        WHERE i.run_id = retention_runs.id AND i.status IN ('candidate', 'd1_deleted'))
  `).bind(now, now).run();
}

async function readClaimedWork(
  db: D1Database,
  runId: string,
  messageId: string,
  leaseOwner: string,
): Promise<RetentionWorkItem> {
  const row = await db.prepare(`
    SELECT i.*, r.mailbox_id, r.cutoff_at, r.exclude_starred, r.exclude_labeled
    FROM retention_run_items i JOIN retention_runs r ON r.id = i.run_id
    WHERE i.run_id = ? AND i.message_id = ? AND i.lease_owner = ?
  `).bind(runId, messageId, leaseOwner).first<Record<string, unknown>>();
  if (row === null) throw new Error('retention work claim became unavailable');
  return {
    runId: String(row.run_id), messageId: String(row.message_id),
    status: row.status as RetentionRunItem['status'],
    subjectSnapshot: String(row.subject_snapshot), receivedAt: Number(row.received_at),
    deletedAt: Number(row.deleted_at), bytes: Number(row.bytes),
    objectKeys: JSON.parse(String(row.object_keys_json)) as string[],
    nextObjectIndex: Number(row.next_object_index), attempts: Number(row.attempts),
    d1DeletedAt: row.d1_deleted_at === null ? null : Number(row.d1_deleted_at),
    errorSummary: String(row.error_summary), createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at), mailboxId: String(row.mailbox_id),
    cutoffAt: Number(row.cutoff_at), excludeStarred: Number(row.exclude_starred) === 1,
    excludeLabeled: Number(row.exclude_labeled) === 1, leaseOwner,
  };
}

function boundedRequired(value: string, field: string, max: number): string {
  const normalized = value.trim();
  if (normalized === '' || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new DatabaseInputError(field, `must be between 1 and ${max} visible characters`);
  }
  return normalized;
}

function errorSummary(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
