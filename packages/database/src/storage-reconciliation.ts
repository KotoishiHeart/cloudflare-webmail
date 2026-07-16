import { requireTimestamp } from './validation.js';

export type StorageIssueType =
  | 'orphan_staging_raw'
  | 'orphan_staging_payload'
  | 'invalid_staging_payload'
  | 'staging_recovery_failed'
  | 'staging_cleanup_failed'
  | 'canonical_object_missing'
  | 'orphan_canonical_object';

export type StorageReference = {
  objectKey: string;
  mailboxId: string;
  messageId: string;
  kind: string;
};

export async function getMaintenanceCursor(db: D1Database, task: string): Promise<string> {
  const row = await db.prepare(
    'SELECT cursor FROM maintenance_cursors WHERE task = ?',
  ).bind(bounded(task, 64, 'task')).first<{ cursor: string }>();
  return row?.cursor ?? '';
}

export async function saveMaintenanceCursor(
  db: D1Database,
  task: string,
  cursor: string,
  nowInput: number,
): Promise<void> {
  const now = requireTimestamp(nowInput);
  if (cursor.length > 2048) throw new Error('maintenance cursor exceeds 2048 characters');
  await db.prepare(`
    INSERT INTO maintenance_cursors (task, cursor, cycle_started_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(task) DO UPDATE SET
      cursor = excluded.cursor,
      cycle_started_at = CASE
        WHEN excluded.cursor = '' THEN excluded.cycle_started_at
        ELSE maintenance_cursors.cycle_started_at
      END,
      updated_at = excluded.updated_at
  `).bind(bounded(task, 64, 'task'), cursor, now, now).run();
}

export async function recordStorageIssue(
  db: D1Database,
  issueType: StorageIssueType,
  objectKey: string,
  nowInput: number,
  context: { mailboxId?: string; messageId?: string; details?: string } = {},
): Promise<void> {
  const now = requireTimestamp(nowInput);
  await db.prepare(`
    INSERT INTO storage_issues (
      issue_type, object_key, mailbox_id, message_id, status,
      details, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)
    ON CONFLICT(issue_type, object_key) DO UPDATE SET
      mailbox_id = excluded.mailbox_id,
      message_id = excluded.message_id,
      status = 'open',
      details = excluded.details,
      occurrences = storage_issues.occurrences + 1,
      last_seen_at = excluded.last_seen_at,
      resolved_at = 0
  `).bind(
    issueType,
    bounded(objectKey, 1024, 'objectKey'),
    nullableBounded(context.mailboxId, 128),
    nullableBounded(context.messageId, 128),
    cleanDetails(context.details),
    now,
    now,
  ).run();
}

export async function resolveStorageIssue(
  db: D1Database,
  issueType: StorageIssueType,
  objectKey: string,
  nowInput: number,
): Promise<void> {
  const now = requireTimestamp(nowInput);
  await db.prepare(`
    UPDATE storage_issues SET status = 'resolved', resolved_at = ?
    WHERE issue_type = ? AND object_key = ? AND status = 'open'
  `).bind(now, issueType, bounded(objectKey, 1024, 'objectKey')).run();
}

export async function resolveStorageIssuesForKeys(
  db: D1Database,
  objectKeys: readonly string[],
  nowInput: number,
): Promise<void> {
  if (objectKeys.length === 0) return;
  const now = requireTimestamp(nowInput);
  await db.batch(objectKeys.map((key) => db.prepare(`
    UPDATE storage_issues SET status = 'resolved', resolved_at = ?
    WHERE object_key = ? AND status = 'open'
  `).bind(now, bounded(key, 1024, 'objectKey'))));
}

export async function listStorageReferences(
  db: D1Database,
  afterKey: string,
  limit = 50,
): Promise<StorageReference[]> {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await db.prepare(`
    SELECT object_key, mailbox_id, message_id, kind FROM (
      SELECT raw_key AS object_key, mailbox_id, id AS message_id, 'raw' AS kind FROM messages
      UNION ALL
      SELECT body_text_key, mailbox_id, id, 'body_text' FROM messages
      WHERE body_text_key IS NOT NULL
      UNION ALL
      SELECT body_html_key, mailbox_id, id, 'body_html' FROM messages
      WHERE body_html_key IS NOT NULL
      UNION ALL
      SELECT a.storage_key, m.mailbox_id, a.message_id, 'attachment'
      FROM attachments AS a JOIN messages AS m ON m.id = a.message_id
    )
    WHERE object_key > ?
    ORDER BY object_key
    LIMIT ?
  `).bind(afterKey, boundedLimit).all<{
    object_key: string;
    mailbox_id: string;
    message_id: string;
    kind: string;
  }>();
  return rows.results.map((row) => ({
    objectKey: row.object_key,
    mailboxId: row.mailbox_id,
    messageId: row.message_id,
    kind: row.kind,
  }));
}

export async function isStorageKeyReferenced(
  db: D1Database,
  objectKey: string,
): Promise<boolean> {
  const row = await db.prepare(`
    SELECT EXISTS (
      SELECT 1 FROM messages
      WHERE raw_key = ? OR body_text_key = ? OR body_html_key = ?
      UNION ALL
      SELECT 1 FROM attachments WHERE storage_key = ?
    ) AS found
  `).bind(objectKey, objectKey, objectKey, objectKey).first<{ found: number }>();
  return row?.found === 1;
}

function nullableBounded(value: string | undefined, maximum: number): string | null {
  if (value === undefined) return null;
  return bounded(value, maximum, 'context');
}

function cleanDetails(value: string | undefined): string {
  if (value === undefined) return '';
  return value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 1024);
}

function bounded(value: string, maximum: number, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${field} must contain between 1 and ${maximum} characters`);
  }
  return normalized;
}
