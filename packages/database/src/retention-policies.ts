import type { RetentionPolicy } from './retention-domain.js';
import { DatabaseInputError, normalizeId, requireTimestamp } from './validation.js';

export async function getRetentionPolicy(
  db: D1Database,
  mailboxIdInput: string,
): Promise<RetentionPolicy | null> {
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const row = await db.prepare(`
    SELECT mailbox_id, retention_days, exclude_starred, exclude_labeled,
      enabled, created_at, updated_at
    FROM retention_policies WHERE mailbox_id = ?
  `).bind(mailboxId).first<{
    mailbox_id: string; retention_days: number; exclude_starred: number;
    exclude_labeled: number; enabled: number; created_at: number; updated_at: number;
  }>();
  return row === null ? null : {
    mailboxId: row.mailbox_id,
    retentionDays: row.retention_days,
    excludeStarred: row.exclude_starred === 1,
    excludeLabeled: row.exclude_labeled === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function saveRetentionPolicy(
  db: D1Database,
  input: {
    mailboxId: string;
    retentionDays: number;
    excludeStarred: boolean;
    excludeLabeled: boolean;
    enabled: boolean;
    now: number;
  },
): Promise<RetentionPolicy | null> {
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  if (!Number.isSafeInteger(input.retentionDays) || input.retentionDays < 1
    || input.retentionDays > 3650) {
    throw new DatabaseInputError('retentionDays', 'must be between 1 and 3650');
  }
  const mailbox = await db.prepare('SELECT 1 AS found FROM mailboxes WHERE id = ?')
    .bind(mailboxId).first();
  if (mailbox === null) return null;
  const now = requireTimestamp(input.now);
  await db.prepare(`
    INSERT INTO retention_policies (
      mailbox_id, retention_days, exclude_starred, exclude_labeled,
      enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mailbox_id) DO UPDATE SET
      retention_days = excluded.retention_days,
      exclude_starred = excluded.exclude_starred,
      exclude_labeled = excluded.exclude_labeled,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).bind(
    mailboxId, input.retentionDays, input.excludeStarred ? 1 : 0,
    input.excludeLabeled ? 1 : 0, input.enabled ? 1 : 0, now, now,
  ).run();
  return getRetentionPolicy(db, mailboxId);
}

export async function ensureDefaultRetentionPolicy(
  db: D1Database,
  mailboxIdInput: string,
  nowInput: number,
): Promise<void> {
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const now = requireTimestamp(nowInput);
  await db.prepare(`
    INSERT OR IGNORE INTO retention_policies (
      mailbox_id, retention_days, exclude_starred, exclude_labeled,
      enabled, created_at, updated_at
    )
    SELECT id, 30, 1, 1, 0, ?, ? FROM mailboxes WHERE id = ?
  `).bind(now, now, mailboxId).run();
}
