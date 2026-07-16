import { normalizeId, requireTimestamp } from './validation.js';

export type DeadLetterSource = 'inbound' | 'outbound';

export type QueueDeadLetterRecord = {
  id: string;
  source: DeadLetterSource;
  deadLetterQueue: string;
  sourceMessageId: string;
  messageId: string | null;
  mailboxId: string | null;
  payloadJson: string;
  payloadSha256: string;
  payloadValid: boolean;
};

export type RequestedDeadLetter = {
  id: string;
  source: DeadLetterSource;
  payload: unknown;
};

export async function saveQueueDeadLetter(
  db: D1Database,
  record: QueueDeadLetterRecord,
  nowInput: number,
): Promise<void> {
  const now = requireTimestamp(nowInput);
  const id = requireSha256(record.id, 'id');
  const payloadSha256 = requireSha256(record.payloadSha256, 'payloadSha256');
  if (record.payloadJson.length < 1 || record.payloadJson.length > 131072) {
    throw new Error('dead-letter payload JSON exceeds the D1 limit');
  }
  await db.prepare(`
    INSERT INTO queue_dead_letters (
      id, source_queue, dead_letter_queue, source_message_id,
      message_id, mailbox_id, payload_json, payload_sha256,
      payload_valid, status, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_message_id = excluded.source_message_id,
      message_id = excluded.message_id,
      mailbox_id = excluded.mailbox_id,
      payload_json = excluded.payload_json,
      payload_valid = excluded.payload_valid,
      status = 'pending',
      occurrences = queue_dead_letters.occurrences + 1,
      last_seen_at = excluded.last_seen_at,
      retry_requested_at = 0,
      requeued_at = 0,
      resolved_at = 0,
      last_error = ''
  `).bind(
    id,
    record.source,
    bounded(record.deadLetterQueue, 128, 'deadLetterQueue'),
    bounded(record.sourceMessageId, 128, 'sourceMessageId'),
    nullableId(record.messageId, 'messageId'),
    nullableId(record.mailboxId, 'mailboxId'),
    record.payloadJson,
    payloadSha256,
    record.payloadValid ? 1 : 0,
    now,
    now,
  ).run();
}

export async function listRequestedDeadLetters(
  db: D1Database,
  limit = 25,
): Promise<RequestedDeadLetter[]> {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await db.prepare(`
    SELECT id, source_queue, payload_json
    FROM queue_dead_letters
    WHERE status = 'retry_requested' AND payload_valid = 1
    ORDER BY retry_requested_at, first_seen_at
    LIMIT ?
  `).bind(boundedLimit).all<{
    id: string;
    source_queue: DeadLetterSource;
    payload_json: string;
  }>();
  return rows.results.map((row) => ({
    id: row.id,
    source: row.source_queue,
    payload: JSON.parse(row.payload_json) as unknown,
  }));
}

export async function markDeadLetterRequeued(
  db: D1Database,
  idInput: string,
  nowInput: number,
): Promise<void> {
  const now = requireTimestamp(nowInput);
  await db.prepare(`
    UPDATE queue_dead_letters
    SET status = 'requeued', requeued_at = ?, last_error = ''
    WHERE id = ? AND status = 'retry_requested'
  `).bind(now, requireSha256(idInput, 'id')).run();
}

export async function recordDeadLetterRetryError(
  db: D1Database,
  idInput: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.prepare(`
    UPDATE queue_dead_letters SET last_error = ?
    WHERE id = ? AND status = 'retry_requested'
  `).bind(bounded(message, 1024, 'retryError'), requireSha256(idInput, 'id')).run();
}

export async function resolveDeadLettersForMessage(
  db: D1Database,
  source: DeadLetterSource,
  messageIdInput: string,
  nowInput: number,
): Promise<void> {
  const now = requireTimestamp(nowInput);
  await db.prepare(`
    UPDATE queue_dead_letters
    SET status = 'resolved', resolved_at = ?, last_error = ''
    WHERE source_queue = ? AND message_id = ? AND status = 'requeued'
  `).bind(now, source, normalizeId(messageIdInput, 'messageId')).run();
}

function nullableId(value: string | null, field: string): string | null {
  return value === null ? null : normalizeId(value, field);
}

function requireSha256(value: string, field: string): string {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new Error(`${field} must be a SHA-256 digest`);
  return normalized;
}

function bounded(value: string, maximum: number, field: string): string {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ');
  if (normalized.length === 0) throw new Error(`${field} must not be empty`);
  return normalized.slice(0, maximum);
}
