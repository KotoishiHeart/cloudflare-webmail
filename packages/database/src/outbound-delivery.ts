import type {
  RecoverableOutboundMessage,
} from './outbound-domain.js';
import { normalizeId, requireTimestamp } from './validation.js';
export { getOutboundDeliveryMessage } from './outbound-delivery-read.js';

export async function claimOutboundDelivery(
  db: D1Database,
  messageIdInput: string,
  leaseTokenInput: string,
  nowInput: number,
  leaseMilliseconds = 5 * 60 * 1000,
): Promise<boolean> {
  const messageId = normalizeId(messageIdInput, 'messageId');
  const leaseToken = normalizeId(leaseTokenInput, 'leaseToken');
  const now = requireTimestamp(nowInput);
  const leaseExpiresAt = now + leaseMilliseconds;
  const result = await db.prepare(`
    UPDATE outbound_deliveries
    SET status = 'sending', attempt_count = attempt_count + 1,
      lease_expires_at = ?, lease_token = ?, updated_at = ?,
      last_error_code = '', last_error_message = ''
    WHERE message_id = ?
      AND attempt_count < 10
      AND next_attempt_at <= ?
      AND (
        status = 'queued'
        OR (status = 'sending' AND lease_expires_at <= ?)
      )
  `).bind(leaseExpiresAt, leaseToken, now, messageId, now, now).run();
  const claimed = Number(result.meta.changes ?? 0) === 1;
  if (claimed) {
    await db.prepare(`
      UPDATE messages SET status = 'sending', processing_error = '', updated_at = ?
      WHERE id = ? AND direction = 'outbound'
    `).bind(now, messageId).run();
  }
  return claimed;
}

export async function completeOutboundDelivery(
  db: D1Database,
  messageIdInput: string,
  leaseTokenInput: string,
  providerMessageIdInput: string,
  nowInput: number,
): Promise<boolean> {
  const messageId = normalizeId(messageIdInput, 'messageId');
  const leaseToken = normalizeId(leaseTokenInput, 'leaseToken');
  const providerMessageId = providerMessageIdInput.trim().slice(0, 998);
  if (providerMessageId.length === 0) throw new Error('provider message ID is required');
  const now = requireTimestamp(nowInput);
  const results = await db.batch([
    db.prepare(`
      UPDATE messages SET status = 'sent', processing_error = '', updated_at = ?
      WHERE id = ? AND direction = 'outbound' AND EXISTS (
        SELECT 1 FROM outbound_deliveries
        WHERE message_id = ? AND status = 'sending' AND lease_token = ?
      )
    `).bind(now, messageId, messageId, leaseToken),
    db.prepare(`
      UPDATE outbound_deliveries
      SET status = 'sent', provider_message_id = ?, sent_at = ?,
        lease_expires_at = 0, lease_token = '',
        last_error_code = '', last_error_message = '', updated_at = ?
      WHERE message_id = ? AND status = 'sending' AND lease_token = ?
    `).bind(providerMessageId, now, now, messageId, leaseToken),
  ]);
  return Number(results[1]?.meta.changes ?? 0) === 1;
}

export async function failOutboundDelivery(
  db: D1Database,
  messageIdInput: string,
  leaseTokenInput: string,
  errorCodeInput: string,
  errorMessageInput: string,
  permanent: boolean,
  nextAttemptAtInput: number,
  nowInput: number,
): Promise<boolean> {
  const messageId = normalizeId(messageIdInput, 'messageId');
  const leaseToken = normalizeId(leaseTokenInput, 'leaseToken');
  const now = requireTimestamp(nowInput);
  const nextAttemptAt = requireTimestamp(nextAttemptAtInput, 'nextAttemptAt');
  const errorCode = boundedError(errorCodeInput, 64, 'unknown');
  const errorMessage = boundedError(errorMessageInput, 1024, 'outbound delivery failed');
  const status = permanent ? 'failed' : 'queued';
  const results = await db.batch([
    db.prepare(`
      UPDATE messages SET status = ?, processing_error = ?, updated_at = ?
      WHERE id = ? AND direction = 'outbound' AND EXISTS (
        SELECT 1 FROM outbound_deliveries
        WHERE message_id = ? AND status = 'sending' AND lease_token = ?
      )
    `).bind(status, errorCode, now, messageId, messageId, leaseToken),
    db.prepare(`
      UPDATE outbound_deliveries
      SET status = ?, next_attempt_at = ?, lease_expires_at = 0, lease_token = '',
        last_error_code = ?, last_error_message = ?, updated_at = ?
      WHERE message_id = ? AND status = 'sending' AND lease_token = ?
    `).bind(status, nextAttemptAt, errorCode, errorMessage, now, messageId, leaseToken),
  ]);
  return Number(results[1]?.meta.changes ?? 0) === 1;
}

export async function exhaustOutboundDelivery(
  db: D1Database,
  messageIdInput: string,
  nowInput: number,
): Promise<boolean> {
  const messageId = normalizeId(messageIdInput, 'messageId');
  const now = requireTimestamp(nowInput);
  const results = await db.batch([
    db.prepare(`
      UPDATE messages SET status = 'failed', processing_error = 'retry_exhausted',
        updated_at = ?
      WHERE id = ? AND direction = 'outbound' AND EXISTS (
        SELECT 1 FROM outbound_deliveries
        WHERE message_id = ? AND attempt_count >= 10
          AND (status = 'queued' OR (status = 'sending' AND lease_expires_at <= ?))
      )
    `).bind(now, messageId, messageId, now),
    db.prepare(`
      UPDATE outbound_deliveries
      SET status = 'failed', lease_expires_at = 0, lease_token = '',
        last_error_code = 'retry_exhausted',
        last_error_message = 'outbound retry limit reached', updated_at = ?
      WHERE message_id = ? AND attempt_count >= 10
        AND (status = 'queued' OR (status = 'sending' AND lease_expires_at <= ?))
    `).bind(now, messageId, now),
  ]);
  return Number(results[1]?.meta.changes ?? 0) === 1;
}

export async function listRecoverableOutboundMessages(
  db: D1Database,
  nowInput: number,
  staleBeforeInput: number,
  limit = 100,
): Promise<RecoverableOutboundMessage[]> {
  const now = requireTimestamp(nowInput);
  const staleBefore = requireTimestamp(staleBeforeInput, 'staleBefore');
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = await db.prepare(`
    SELECT message_id, mailbox_id
    FROM outbound_deliveries
    WHERE attempt_count < 10 AND (
      (status = 'queued' AND next_attempt_at <= ? AND enqueued_at <= ?)
      OR (status = 'sending' AND lease_expires_at > 0 AND lease_expires_at <= ?)
    )
    ORDER BY next_attempt_at, created_at
    LIMIT ?
  `).bind(now, staleBefore, now, boundedLimit).all<{
    message_id: string;
    mailbox_id: string;
  }>();
  return result.results.map((row) => ({
    messageId: row.message_id,
    mailboxId: row.mailbox_id,
  }));
}

export async function markOutboundEnqueued(
  db: D1Database,
  messageIds: readonly string[],
  nowInput: number,
): Promise<void> {
  if (messageIds.length === 0) return;
  const now = requireTimestamp(nowInput);
  await db.batch(messageIds.map((id) => db.prepare(`
    UPDATE outbound_deliveries SET enqueued_at = ?, updated_at = ?
    WHERE message_id = ? AND status IN ('queued', 'sending')
  `).bind(now, now, normalizeId(id, 'messageId'))));
}

function boundedError(value: string, maximum: number, fallback: string): string {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ');
  return (normalized || fallback).slice(0, maximum);
}
