import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  provisionMailboxWithOwner,
  provisionUserWithIdentity,
  setMailboxMembership,
} from '@cf-webmail/database';
import type { AccessIdentity } from '../apps/web/src/access-auth.js';
import { handleWebRequest } from '../apps/web/src/app.js';
import { handleOutboundBatch } from '../apps/jobs/src/outbound-consumer.js';
import { recoverOutboundDeliveries } from '../apps/jobs/src/outbound-recovery.js';

const ORIGIN = 'https://webmail.example.com';
const NOW = Date.UTC(2026, 6, 16, 16);
const USER_ID = '019c315c-1f20-7000-8000-000000000511';
const MAILBOX_ID = '019c315c-1f20-7000-8000-000000000512';
const VIEWER_ID = '019c315c-1f20-7000-8000-000000000516';
const IDENTITY: AccessIdentity = {
  issuer: 'https://team.cloudflareaccess.com',
  subject: 'outbound-owner',
  email: 'outbound-owner@example.com',
};
const VIEWER: AccessIdentity = {
  issuer: IDENTITY.issuer,
  subject: 'outbound-viewer',
  email: 'outbound-viewer@example.com',
};

describe('outbound delivery', () => {
  beforeAll(async () => {
    await provisionUserWithIdentity(env.DB, {
      userId: USER_ID,
      email: IDENTITY.email,
      identity: IDENTITY,
      now: NOW,
    });
    await provisionMailboxWithOwner(env.DB, {
      mailboxId: MAILBOX_ID,
      ownerUserId: USER_ID,
      address: 'sender@example.com',
      displayName: '送信テスト',
      now: NOW,
    });
    await provisionUserWithIdentity(env.DB, {
      userId: VIEWER_ID,
      email: VIEWER.email,
      identity: VIEWER,
      now: NOW,
    });
    await setMailboxMembership(env.DB, {
      mailboxId: MAILBOX_ID,
      userId: VIEWER_ID,
      role: 'viewer',
      now: NOW + 1,
    });
  });

  it('stores a compose snapshot once for an idempotency key', async () => {
    const key = '019c315c-1f20-7000-8000-000000000513';
    const first = await compose(key, 'Idempotent message');
    expect(first.status).toBe(202);
    const firstPayload = await first.json<{ data: { messageId: string; created: boolean } }>();
    expect(firstPayload.data.created).toBe(true);

    const duplicate = await compose(key, 'This body is ignored for the same key');
    expect(duplicate.status).toBe(200);
    const duplicatePayload = await duplicate.json<{ data: { messageId: string; created: boolean } }>();
    expect(duplicatePayload.data).toMatchObject({
      messageId: firstPayload.data.messageId,
      created: false,
    });

    const delivery = await env.DB.prepare(`
      SELECT status, attempt_count FROM outbound_deliveries WHERE message_id = ?
    `).bind(firstPayload.data.messageId).first<{ status: string; attempt_count: number }>();
    expect(delivery).toEqual({ status: 'queued', attempt_count: 0 });
    const raw = await env.RAW_EMAILS.get(
      `mailboxes/${MAILBOX_ID}/messages/${firstPayload.data.messageId}/raw.eml`,
    );
    expect(raw).not.toBeNull();
    await expect(raw?.text()).resolves.toContain('X-CF-Webmail-Archive: compose-snapshot');
  });

  it('sends stored text and HTML through the binding and finishes once', async () => {
    const created = await compose('019c315c-1f20-7000-8000-000000000514', 'Successful message');
    const payload = await created.json<{ data: { messageId: string } }>();
    const send = vi.fn(async (_builder: EmailMessageBuilder) => ({
      messageId: '<provider-success@example.com>',
    }));
    const first = queueItem(payload.data.messageId);
    await handleOutboundBatch([first.item], {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      email: { send } as SendEmail,
      now: () => NOW + 60_000,
    });
    expect(first.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      to: ['recipient@example.net'],
      cc: ['copy@example.net'],
      bcc: ['hidden@example.net'],
      from: { email: 'sender@example.com', name: '送信テスト' },
      subject: 'Successful message',
      text: '本文です。',
    });

    const second = queueItem(payload.data.messageId, 2);
    await handleOutboundBatch([second.item], {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      email: { send } as SendEmail,
      now: () => NOW + 120_000,
    });
    expect(second.ack).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    const row = await env.DB.prepare(`
      SELECT od.status, od.provider_message_id, m.status AS message_status
      FROM outbound_deliveries AS od JOIN messages AS m ON m.id = od.message_id
      WHERE od.message_id = ?
    `).bind(payload.data.messageId).first<Record<string, string>>();
    expect(row).toMatchObject({
      status: 'sent',
      provider_message_id: '<provider-success@example.com>',
      message_status: 'sent',
    });
  });

  it('records permanent provider errors without retrying the Queue message', async () => {
    const created = await compose('019c315c-1f20-7000-8000-000000000515', 'Permanent failure');
    const payload = await created.json<{ data: { messageId: string } }>();
    const failure = Object.assign(new Error('sender domain is unavailable'), {
      code: 'E_SENDER_DOMAIN_NOT_AVAILABLE',
    });
    const queued = queueItem(payload.data.messageId);
    await handleOutboundBatch([queued.item], {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      email: { send: vi.fn(async () => { throw failure; }) } as unknown as SendEmail,
      now: () => NOW + 180_000,
    });
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    const row = await env.DB.prepare(`
      SELECT status, last_error_code FROM outbound_deliveries WHERE message_id = ?
    `).bind(payload.data.messageId).first<Record<string, string>>();
    expect(row).toEqual({
      status: 'failed',
      last_error_code: 'E_SENDER_DOMAIN_NOT_AVAILABLE',
    });
  });

  it('delays retryable provider errors and retains queued state', async () => {
    const created = await compose('019c315c-1f20-7000-8000-000000000517', 'Retry later');
    const payload = await created.json<{ data: { messageId: string } }>();
    const failure = Object.assign(new Error('rate limited'), { code: 'E_RATE_LIMIT_EXCEEDED' });
    const queued = queueItem(payload.data.messageId);
    await handleOutboundBatch([queued.item], {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      email: { send: vi.fn(async () => { throw failure; }) } as unknown as SendEmail,
      now: () => NOW + 240_000,
    });
    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    const row = await env.DB.prepare(`
      SELECT status, last_error_code, next_attempt_at
      FROM outbound_deliveries WHERE message_id = ?
    `).bind(payload.data.messageId).first<Record<string, string | number>>();
    expect(row).toMatchObject({
      status: 'queued',
      last_error_code: 'E_RATE_LIMIT_EXCEEDED',
      next_attempt_at: NOW + 270_000,
    });
  });

  it('rejects viewers and cross-origin compose requests', async () => {
    const viewer = await compose(
      '019c315c-1f20-7000-8000-000000000518',
      'Viewer attempt',
      VIEWER,
    );
    expect(viewer.status).toBe(403);
    const crossOrigin = await compose(
      '019c315c-1f20-7000-8000-000000000519',
      'Cross origin attempt',
      IDENTITY,
      'https://attacker.example',
    );
    expect(crossOrigin.status).toBe(403);
  });

  it('re-enqueues stale queued deliveries from the scheduled recovery path', async () => {
    const sendBatch = vi.fn(async (_messages: Iterable<unknown>) => undefined);
    const count = await recoverOutboundDeliveries(
      env.DB,
      { sendBatch } as unknown as Queue<unknown>,
      NOW + 10 * 60 * 1000,
    );
    expect(count).toBeGreaterThan(0);
    expect(sendBatch).toHaveBeenCalledOnce();
  });
});

function compose(
  idempotencyKey: string,
  subject: string,
  identity = IDENTITY,
  origin = ORIGIN,
): Promise<Response> {
  return handleWebRequest(new Request(`${ORIGIN}/api/mailboxes/${MAILBOX_ID}/messages`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      to: ['recipient@example.net'],
      cc: ['copy@example.net'],
      bcc: ['hidden@example.net'],
      subject,
      text: '本文です。',
    }),
  }), env, {
    authenticate: async () => ({ ok: true, identity }),
    now: () => NOW + 1_000,
  });
}

function queueItem(messageId: string, attempts = 1) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    ack,
    retry,
    item: {
      body: { schemaVersion: 1, messageId, mailboxId: MAILBOX_ID },
      attempts,
      ack,
      retry,
    },
  };
}
