import type { InboundQueueMessage } from '@cf-webmail/contracts';
import { normalizeId, requireTimestamp } from './validation.js';

export type RecoverableInboundHandoff = {
  messageId: string;
  payload: unknown;
};

export async function recordInboundHandoff(
  db: D1Database,
  message: InboundQueueMessage,
  nowInput: number,
): Promise<void> {
  const now = requireTimestamp(nowInput);
  const messageId = normalizeId(message.messageId, 'messageId');
  const mailboxId = normalizeId(message.mailboxId, 'mailboxId');
  const payload = JSON.stringify(message);
  if (payload.length > 8192) throw new Error('inbound Queue payload exceeds the D1 handoff limit');
  await db.prepare(`
    INSERT INTO inbound_handoffs (
      message_id, mailbox_id, raw_key, queue_payload, status,
      received_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'staged', ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      queue_payload = excluded.queue_payload,
      updated_at = excluded.updated_at
    WHERE inbound_handoffs.mailbox_id = excluded.mailbox_id
      AND inbound_handoffs.raw_key = excluded.raw_key
      AND inbound_handoffs.status <> 'stored'
  `).bind(
    messageId,
    mailboxId,
    message.rawKey,
    payload,
    requireTimestamp(message.receivedAt, 'receivedAt'),
    now,
    now,
  ).run();
}

export async function markInboundHandoffEnqueued(
  db: D1Database,
  messageIdInput: string,
  nowInput: number,
): Promise<void> {
  await updateStatus(db, messageIdInput, 'enqueued', nowInput);
}

export async function markInboundHandoffQueueFailed(
  db: D1Database,
  messageIdInput: string,
  error: unknown,
  nowInput: number,
): Promise<void> {
  const now = requireTimestamp(nowInput);
  await db.prepare(`
    UPDATE inbound_handoffs
    SET status = 'queue_failed', last_error_code = 'queue_send_failed',
      last_error_message = ?, updated_at = ?
    WHERE message_id = ? AND status <> 'stored'
  `).bind(errorMessage(error), now, normalizeId(messageIdInput, 'messageId')).run();
}

export async function beginInboundHandoffProcessing(
  db: D1Database,
  messageIdInput: string,
  nowInput: number,
): Promise<void> {
  const now = requireTimestamp(nowInput);
  await db.prepare(`
    UPDATE inbound_handoffs
    SET status = 'processing', attempt_count = attempt_count + 1,
      last_error_code = '', last_error_message = '', updated_at = ?
    WHERE message_id = ? AND status <> 'stored'
  `).bind(now, normalizeId(messageIdInput, 'messageId')).run();
}

export async function failInboundHandoffProcessing(
  db: D1Database,
  messageIdInput: string,
  codeInput: string,
  error: unknown,
  nowInput: number,
): Promise<void> {
  const now = requireTimestamp(nowInput);
  await db.prepare(`
    UPDATE inbound_handoffs
    SET last_error_code = ?, last_error_message = ?, updated_at = ?
    WHERE message_id = ? AND status <> 'stored'
  `).bind(
    bounded(codeInput, 64, 'processing_failed'),
    errorMessage(error),
    now,
    normalizeId(messageIdInput, 'messageId'),
  ).run();
}

export async function completeInboundHandoff(
  db: D1Database,
  messageIdInput: string,
  storedMessageIdInput: string,
  stagingDeleted: boolean,
  nowInput: number,
): Promise<void> {
  const now = requireTimestamp(nowInput);
  await db.prepare(`
    UPDATE inbound_handoffs
    SET status = 'stored', stored_message_id = ?, staging_deleted = ?,
      last_error_code = '', last_error_message = '', updated_at = ?
    WHERE message_id = ?
  `).bind(
    normalizeId(storedMessageIdInput, 'storedMessageId'),
    stagingDeleted ? 1 : 0,
    now,
    normalizeId(messageIdInput, 'messageId'),
  ).run();
}

export async function markInboundHandoffDeadLetter(
  db: D1Database,
  messageIdInput: string,
  nowInput: number,
): Promise<void> {
  await updateStatus(db, messageIdInput, 'dead_letter', nowInput);
}

export async function listRecoverableInboundHandoffs(
  db: D1Database,
  staleBeforeInput: number,
  limit = 100,
): Promise<RecoverableInboundHandoff[]> {
  const staleBefore = requireTimestamp(staleBeforeInput, 'staleBefore');
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await db.prepare(`
    SELECT message_id, queue_payload
    FROM inbound_handoffs
    WHERE status IN ('staged', 'queue_failed') AND updated_at <= ?
    ORDER BY updated_at, received_at
    LIMIT ?
  `).bind(staleBefore, boundedLimit).all<{ message_id: string; queue_payload: string }>();
  return rows.results.map((row) => ({
    messageId: row.message_id,
    payload: JSON.parse(row.queue_payload) as unknown,
  }));
}

async function updateStatus(
  db: D1Database,
  messageIdInput: string,
  status: 'enqueued' | 'dead_letter',
  nowInput: number,
): Promise<void> {
  const now = requireTimestamp(nowInput);
  await db.prepare(`
    UPDATE inbound_handoffs SET status = ?, updated_at = ?
    WHERE message_id = ? AND status <> 'stored'
  `).bind(status, now, normalizeId(messageIdInput, 'messageId')).run();
}

function errorMessage(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error), 1024, 'unknown error');
}

function bounded(value: string, maximum: number, fallback: string): string {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ');
  return (normalized || fallback).slice(0, maximum);
}
