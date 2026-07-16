import { getRetentionRun } from './retention-runs.js';
import { DatabaseInputError, normalizeId, requireTimestamp } from './validation.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export async function approveRetentionRun(
  db: D1Database,
  input: {
    runId: string;
    userId: string;
    backupReference: string;
    backupManifestSha256: string;
    backupCreatedAt: number;
    now: number;
  },
): Promise<'approved' | 'not-found' | 'invalid-state' | 'empty-preview'> {
  const runId = normalizeId(input.runId, 'runId');
  const userId = normalizeId(input.userId, 'userId');
  const now = requireTimestamp(input.now);
  const backupCreatedAt = requireTimestamp(input.backupCreatedAt, 'backupCreatedAt');
  const reference = boundedReference(input.backupReference);
  const sha256 = input.backupManifestSha256.trim().toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw new DatabaseInputError('backupManifestSha256', 'must be a lowercase SHA-256 digest');
  }
  const current = await getRetentionRun(db, runId);
  if (current === null) return 'not-found';
  if (current.status !== 'preview') return 'invalid-state';
  if (current.candidateCount === 0) return 'empty-preview';
  if (backupCreatedAt < current.createdAt || backupCreatedAt > now) {
    throw new DatabaseInputError(
      'backupCreatedAt',
      'must be between preview creation and approval',
    );
  }
  const result = await db.prepare(`
    UPDATE retention_runs
    SET status = 'approved', backup_reference = ?, backup_manifest_sha256 = ?,
      backup_created_at = ?, approved_by_user_id = ?, approved_at = ?, updated_at = ?
    WHERE id = ? AND status = 'preview'
  `).bind(reference, sha256, backupCreatedAt, userId, now, now, runId).run();
  return result.meta.changes === 1 ? 'approved' : 'invalid-state';
}

export async function cancelRetentionRun(
  db: D1Database,
  runIdInput: string,
  nowInput: number,
): Promise<'cancelled' | 'not-found' | 'invalid-state'> {
  const runId = normalizeId(runIdInput, 'runId');
  const now = requireTimestamp(nowInput);
  const current = await getRetentionRun(db, runId);
  if (current === null) return 'not-found';
  if (current.status !== 'preview' && current.status !== 'approved') return 'invalid-state';
  const result = await db.prepare(`
    UPDATE retention_runs SET status = 'cancelled', completed_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('preview', 'approved')
  `).bind(now, now, runId).run();
  return result.meta.changes === 1 ? 'cancelled' : 'invalid-state';
}

function boundedReference(value: string): string {
  const normalized = value.trim();
  if (
    normalized === '' || normalized.length > 512
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new DatabaseInputError(
      'backupReference', 'must be between 1 and 512 visible characters',
    );
  }
  return normalized;
}
