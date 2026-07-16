import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildInboundQueuePayloadKey,
  type InboundQueueMessage,
} from '@cf-webmail/contracts';
import {
  provisionMailboxWithOwner,
  provisionUserWithIdentity,
} from '@cf-webmail/database';
import { handleInboundEmail, type InboundEmail } from '../apps/ingest/src/email-handler.js';
import jobsWorker from '../apps/jobs/src/index.js';

const NOW = Date.UTC(2026, 6, 16, 13);
const USER_ID = '019c315c-1f20-7000-8000-000000000201';
const MAILBOX_ID = '019c315c-1f20-7000-8000-000000000202';
const ACCOUNT_EMAIL = 'jobs-inbox@example.com';

describe('Queue MIME persistence', () => {
  beforeAll(async () => {
    await provisionUserWithIdentity(env.DB, {
      userId: USER_ID,
      email: 'jobs-owner@example.com',
      identity: {
        issuer: 'https://team.cloudflareaccess.com',
        subject: 'jobs-owner',
      },
      now: NOW,
    });
    await provisionMailboxWithOwner(env.DB, {
      mailboxId: MAILBOX_ID,
      ownerUserId: USER_ID,
      address: ACCOUNT_EMAIL,
      now: NOW,
    });
  });

  it('parses MIME, persists canonical R2 objects, and acknowledges the message', async () => {
    const raw = multipartEmail('first');
    const queued = await stageInbound(raw, '019c315c-1f20-7000-8000-000000000203');
    const queueResult = await dispatchQueue(queued, 'queue-message-203');

    expect(queueResult.explicitAcks).toContain('queue-message-203');
    expect(queueResult.retryMessages).toEqual([]);
    const row = await env.DB.prepare(`
      SELECT id, mailbox_id, status, subject, sender, recipients,
        raw_key, raw_sha256, body_text_key, attachment_count, text_preview
      FROM messages WHERE id = ?
    `).bind(queued.messageId).first<Record<string, string | number | null>>();
    expect(row).toMatchObject({
      id: queued.messageId,
      mailbox_id: MAILBOX_ID,
      status: 'ready',
      subject: 'テスト',
      attachment_count: 1,
    });
    expect(String(row?.sender)).toContain('sender@example.net');
    expect(String(row?.recipients)).toContain(ACCOUNT_EMAIL);
    expect(String(row?.text_preview)).toContain('plain body');
    expect(String(row?.raw_sha256)).toMatch(/^[0-9a-f]{64}$/u);

    await expect(env.RAW_EMAILS.get(queued.rawKey)).resolves.toBeNull();
    await expect(env.RAW_EMAILS.get(
      buildInboundQueuePayloadKey(queued.rawKey),
    )).resolves.toBeNull();
    const rawObject = await env.RAW_EMAILS.get(String(row?.raw_key));
    expect(rawObject).not.toBeNull();
    await expect(rawObject?.text()).resolves.toBe(raw);

    const bodyObject = await env.RAW_EMAILS.get(String(row?.body_text_key));
    expect(bodyObject).not.toBeNull();
    await expect(bodyObject?.text()).resolves.toContain('plain body');

    const attachment = await env.DB.prepare(`
      SELECT filename, content_type, size, sha256, storage_key
      FROM attachments WHERE message_id = ? AND ordinal = 0
    `).bind(queued.messageId).first<Record<string, string | number>>();
    expect(attachment).toMatchObject({
      filename: 'hello.txt',
      content_type: 'text/plain',
      size: 16,
    });
    expect(String(attachment?.sha256)).toMatch(/^[0-9a-f]{64}$/u);
    const attachmentObject = await env.RAW_EMAILS.get(String(attachment?.storage_key));
    expect(attachmentObject).not.toBeNull();
    await expect(attachmentObject?.text()).resolves.toBe('hello attachment');
    const handoff = await env.DB.prepare(`
      SELECT status, attempt_count, staging_deleted, stored_message_id
      FROM inbound_handoffs WHERE message_id = ?
    `).bind(queued.messageId).first<Record<string, string | number | null>>();
    expect(handoff).toMatchObject({
      status: 'stored',
      attempt_count: 1,
      staging_deleted: 1,
      stored_message_id: queued.messageId,
    });
  });

  it('acknowledges an exact Queue redelivery without duplicating rows', async () => {
    const raw = multipartEmail('redelivery');
    const queued = await stageInbound(raw, '019c315c-1f20-7000-8000-000000000204');
    const first = await dispatchQueue(queued, 'queue-message-204-first');
    const second = await dispatchQueue(queued, 'queue-message-204-second', 2);

    expect(first.explicitAcks).toContain('queue-message-204-first');
    expect(second.explicitAcks).toContain('queue-message-204-second');
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM messages WHERE id = ?')
      .bind(queued.messageId)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
    const attachmentCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM attachments WHERE message_id = ?',
    ).bind(queued.messageId)
      .first<{ count: number }>();
    expect(attachmentCount?.count).toBe(1);
  });

  it('deduplicates equal raw content across different ingestion IDs', async () => {
    const raw = multipartEmail('content-duplicate');
    const original = await stageInbound(raw, '019c315c-1f20-7000-8000-000000000205');
    const duplicate = await stageInbound(raw, '019c315c-1f20-7000-8000-000000000206');
    const originalResult = await dispatchQueue(original, 'queue-message-205');
    const duplicateResult = await dispatchQueue(duplicate, 'queue-message-206');

    expect(originalResult.explicitAcks).toContain('queue-message-205');
    expect(duplicateResult.explicitAcks).toContain('queue-message-206');
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM messages WHERE id = ?')
      .bind(duplicate.messageId)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
    const existing = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM messages
      WHERE mailbox_id = ? AND id = ?
    `).bind(MAILBOX_ID, original.messageId)
      .first<{ count: number }>();
    expect(existing?.count).toBe(1);
    await expect(env.RAW_EMAILS.get(duplicate.rawKey)).resolves.toBeNull();
    await expect(env.RAW_EMAILS.get(
      `mailboxes/${MAILBOX_ID}/messages/${duplicate.messageId}/raw.eml`,
    )).resolves.toBeNull();
  });

  it('retries an invalid contract so configured DLQ handling can retain it', async () => {
    const result = await dispatchQueue({ schemaVersion: 999 }, 'queue-invalid');
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: 'queue-invalid' }]);
  });
});

async function stageInbound(raw: string, messageId: string): Promise<InboundQueueMessage> {
  const bytes = new TextEncoder().encode(raw);
  let queued: InboundQueueMessage | undefined;
  const message = createEmail(raw, bytes);
  const result = await handleInboundEmail(message, {
    db: env.DB,
    rawEmails: env.RAW_EMAILS,
    enqueue: async (body) => {
      queued = body;
    },
  }, { messageId, receivedAt: NOW });
  expect(result.accepted).toBe(true);
  if (queued === undefined) throw new Error('expected an enqueued message');
  return queued;
}

async function dispatchQueue(
  body: unknown,
  queueId: string,
  attempts = 1,
) {
  const batch = createMessageBatch('cf-webmail-inbound', [{
    id: queueId,
    timestamp: new Date(NOW),
    attempts,
    body,
  }]);
  const ctx = createExecutionContext();
  await jobsWorker.queue(batch, env);
  return getQueueResult(batch, ctx);
}

function createEmail(raw: string, bytes: Uint8Array): InboundEmail {
  const headers = new Headers();
  for (const line of (raw.split('\r\n\r\n', 1)[0] ?? '').split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) headers.append(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return {
    from: 'sender@example.net',
    to: ACCOUNT_EMAIL,
    headers,
    raw: new Blob([bytes.slice().buffer]).stream(),
    rawSize: bytes.byteLength,
    setReject: vi.fn(),
  };
}

function multipartEmail(label: string): string {
  return [
    'From: Sender <sender@example.net>',
    `To: Inbox <${ACCOUNT_EMAIL}>`,
    'Subject: =?UTF-8?B?44OG44K544OI?=',
    'Message-ID: <jobs-test@example.net>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    '--outer',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `plain body ${label}`,
    '--outer',
    'Content-Type: text/plain; name="hello.txt"',
    'Content-Disposition: attachment; filename="hello.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    'aGVsbG8gYXR0YWNobWVudA==',
    '--outer--',
    '',
  ].join('\r\n');
}
