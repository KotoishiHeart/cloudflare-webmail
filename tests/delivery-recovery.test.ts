import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  INBOUND_DEAD_LETTER_QUEUE_NAME,
  INBOUND_QUEUE_SCHEMA_VERSION,
  type InboundQueueMessage,
} from '@cf-webmail/contracts';
import {
  markInboundHandoffQueueFailed,
  provisionMailboxWithOwner,
  provisionUserWithIdentity,
  recordInboundHandoff,
} from '@cf-webmail/database';
import { handleDeadLetterBatch } from '../apps/jobs/src/dead-letter-consumer.js';
import { recoverRequestedDeadLetters } from '../apps/jobs/src/dead-letter-recovery.js';
import { recoverInboundHandoffs } from '../apps/jobs/src/inbound-recovery.js';

const NOW = Date.UTC(2026, 6, 16, 14);
const USER_ID = '019c315c-1f20-7000-8000-000000000701';
const MAILBOX_ID = '019c315c-1f20-7000-8000-000000000702';
const MESSAGE_ID = '019c315c-1f20-7000-8000-000000000703';

describe('Queue recovery ledger', () => {
  beforeAll(async () => {
    await provisionUserWithIdentity(env.DB, {
      userId: USER_ID,
      email: 'recovery-owner@example.com',
      identity: {
        issuer: 'https://team.cloudflareaccess.com',
        subject: 'recovery-owner',
      },
      now: NOW,
    });
    await provisionMailboxWithOwner(env.DB, {
      mailboxId: MAILBOX_ID,
      ownerUserId: USER_ID,
      address: 'recovery@example.com',
      now: NOW,
    });
  });

  it('re-enqueues a stale failed inbound handoff and marks it enqueued', async () => {
    const payload = inboundPayload(MESSAGE_ID);
    await recordInboundHandoff(env.DB, payload, NOW);
    await markInboundHandoffQueueFailed(env.DB, MESSAGE_ID, new Error('Queue down'), NOW);
    const send = vi.fn(async () => {});
    const result = await recoverInboundHandoffs(
      env.DB,
      { send } as unknown as Queue<unknown>,
      NOW + 6 * 60 * 1000,
    );

    expect(result).toEqual({ requeued: 1, failed: 0 });
    expect(send).toHaveBeenCalledWith(payload, { contentType: 'json' });
    const row = await env.DB.prepare(
      'SELECT status FROM inbound_handoffs WHERE message_id = ?',
    ).bind(MESSAGE_ID).first<{ status: string }>();
    expect(row?.status).toBe('enqueued');
  });

  it('persists DLQ payloads idempotently before acknowledgement', async () => {
    const payload = inboundPayload('019c315c-1f20-7000-8000-000000000704');
    const first = queueItem('dead-letter-source-1', payload);
    const second = queueItem('dead-letter-source-2', payload);
    const firstResult = await handleDeadLetterBatch(
      INBOUND_DEAD_LETTER_QUEUE_NAME,
      [first.item],
      env.DB,
      NOW,
    );
    const secondResult = await handleDeadLetterBatch(
      INBOUND_DEAD_LETTER_QUEUE_NAME,
      [second.item],
      env.DB,
      NOW + 1,
    );

    expect(firstResult).toEqual({ acknowledged: 1, retried: 0, invalid: 0 });
    expect(secondResult).toEqual({ acknowledged: 1, retried: 0, invalid: 0 });
    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.ack).toHaveBeenCalledOnce();
    const row = await env.DB.prepare(`
      SELECT id, status, occurrences, payload_valid, source_message_id
      FROM queue_dead_letters WHERE message_id = ?
    `).bind(payload.messageId).first<{
      id: string;
      status: string;
      occurrences: number;
      payload_valid: number;
      source_message_id: string;
    }>();
    expect(row).toMatchObject({
      status: 'pending',
      occurrences: 2,
      payload_valid: 1,
      source_message_id: 'dead-letter-source-2',
    });

    await env.DB.prepare(`
      UPDATE queue_dead_letters
      SET status = 'retry_requested', retry_requested_at = ?
      WHERE id = ?
    `).bind(NOW + 2, row?.id).run();
    const inboundSend = vi.fn(async () => {});
    const outboundSend = vi.fn(async () => {});
    const recovered = await recoverRequestedDeadLetters(
      env.DB,
      { send: inboundSend } as unknown as Queue<unknown>,
      { send: outboundSend } as unknown as Queue<unknown>,
      NOW + 3,
    );
    expect(recovered).toEqual({ requeued: 1, failed: 0 });
    expect(inboundSend).toHaveBeenCalledWith(payload, { contentType: 'json' });
    expect(outboundSend).not.toHaveBeenCalled();
    const requeued = await env.DB.prepare(
      'SELECT status FROM queue_dead_letters WHERE id = ?',
    ).bind(row?.id).first<{ status: string }>();
    expect(requeued?.status).toBe('requeued');
  });

  it('retains an invalid DLQ payload for inspection without making it retryable', async () => {
    const queued = queueItem('dead-letter-invalid', { schemaVersion: 999 });
    const result = await handleDeadLetterBatch(
      INBOUND_DEAD_LETTER_QUEUE_NAME,
      [queued.item],
      env.DB,
      NOW,
    );
    expect(result).toEqual({ acknowledged: 1, retried: 0, invalid: 1 });
    expect(queued.ack).toHaveBeenCalledOnce();
    const row = await env.DB.prepare(`
      SELECT status, payload_valid FROM queue_dead_letters
      WHERE source_message_id = ?
    `).bind('dead-letter-invalid').first<{ status: string; payload_valid: number }>();
    expect(row).toEqual({ status: 'pending', payload_valid: 0 });
  });
});

function inboundPayload(messageId: string): InboundQueueMessage {
  return {
    schemaVersion: INBOUND_QUEUE_SCHEMA_VERSION,
    messageId,
    mailboxId: MAILBOX_ID,
    rawKey: `staging/raw/2026/07/16/${MAILBOX_ID}/${messageId}.eml`,
    envelope: { from: 'sender@example.net', to: 'recovery@example.com' },
    headers: { subject: 'recovery', messageId: '<recovery@example.net>' },
    receivedAt: NOW,
    accountEmail: 'recovery@example.com',
    routing: { action: 'store', policy: 'active-mailbox-v1' },
    staging: { encoding: 'identity', rawSize: 100 },
  };
}

function queueItem(id: string, body: unknown) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    ack,
    retry,
    item: { id, body, attempts: 1, ack, retry },
  };
}
