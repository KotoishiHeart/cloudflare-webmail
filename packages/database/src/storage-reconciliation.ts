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
  afterMessageId: string,
  limit = 50,
): Promise<StorageReference[]> {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  // Page on the messages primary key before joining attachments. Paging the
  // UNION of unindexed object-key columns makes every small audit batch scan
  // the complete mailbox database.
  const rows = await db.prepare(`
    SELECT m.id AS message_id, m.mailbox_id, m.raw_key,
      m.body_text_key, m.body_html_key, a.storage_key
    FROM (
      SELECT id, mailbox_id, raw_key, body_text_key, body_html_key
      FROM messages
      WHERE id > ?
      ORDER BY id
      LIMIT ?
    ) AS m
    LEFT JOIN attachments AS a ON a.message_id = m.id
    ORDER BY m.id, a.ordinal
  `).bind(afterMessageId, boundedLimit).all<{
    mailbox_id: string;
    message_id: string;
    raw_key: string;
    body_text_key: string | null;
    body_html_key: string | null;
    storage_key: string | null;
  }>();
  const references = new Map<string, StorageReference>();
  for (const row of rows.results) {
    addReference(references, row.raw_key, row, 'raw');
    if (row.body_text_key !== null) addReference(references, row.body_text_key, row, 'body_text');
    if (row.body_html_key !== null) addReference(references, row.body_html_key, row, 'body_html');
    if (row.storage_key !== null) addReference(references, row.storage_key, row, 'attachment');
  }
  return [...references.values()];
}

export async function isStorageKeyReferenced(
  db: D1Database,
  objectKey: string,
): Promise<boolean> {
  // Canonical keys carry the indexed message identity. Resolve that identity
  // first instead of scanning the three object-key columns for every R2 item.
  const parsed = parseCanonicalObjectKey(objectKey);
  if (parsed === null) return false;
  if (parsed.kind === 'attachment') {
    const row = await db.prepare(`
      SELECT a.storage_key
      FROM attachments AS a
      JOIN messages AS m ON m.id = a.message_id
      WHERE a.message_id = ? AND a.ordinal = ? AND m.mailbox_id = ?
    `).bind(parsed.messageId, parsed.ordinal, parsed.mailboxId)
      .first<{ storage_key: string }>();
    return row?.storage_key === objectKey;
  }
  const row = await db.prepare(`
    SELECT raw_key, body_text_key, body_html_key
    FROM messages
    WHERE id = ? AND mailbox_id = ?
  `).bind(parsed.messageId, parsed.mailboxId).first<{
    raw_key: string;
    body_text_key: string | null;
    body_html_key: string | null;
  }>();
  if (row === null) return false;
  if (parsed.kind === 'raw') return row.raw_key === objectKey;
  if (parsed.kind === 'body_text') return row.body_text_key === objectKey;
  return row.body_html_key === objectKey;
}

function addReference(
  references: Map<string, StorageReference>,
  objectKey: string,
  row: { mailbox_id: string; message_id: string },
  kind: string,
): void {
  references.set(objectKey, {
    objectKey,
    mailboxId: row.mailbox_id,
    messageId: row.message_id,
    kind,
  });
}

type ParsedCanonicalObjectKey = {
  mailboxId: string;
  messageId: string;
} & (
  | { kind: 'raw' | 'body_text' | 'body_html' }
  | { kind: 'attachment'; ordinal: number }
);

function parseCanonicalObjectKey(objectKey: string): ParsedCanonicalObjectKey | null {
  const match = objectKey.match(
    /^mailboxes\/([^/]+)\/messages\/([^/]+)\/(raw\.eml|body\.txt|body\.html|attachments\/([0-9]{3}))$/u,
  );
  if (match === null) return null;
  const mailboxId = match[1] ?? '';
  const messageId = match[2] ?? '';
  const suffix = match[3] ?? '';
  if (suffix === 'raw.eml') return { mailboxId, messageId, kind: 'raw' };
  if (suffix === 'body.txt') return { mailboxId, messageId, kind: 'body_text' };
  if (suffix === 'body.html') return { mailboxId, messageId, kind: 'body_html' };
  const ordinal = Number(match[4]);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 99) return null;
  return { mailboxId, messageId, kind: 'attachment', ordinal };
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
