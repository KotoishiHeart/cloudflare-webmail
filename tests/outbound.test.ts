import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  persistInboundMessage,
  provisionMailboxWithOwner,
  provisionUserWithIdentity,
  setMailboxMembership,
} from '@cf-webmail/database';
import type { AccessIdentity } from '../apps/web/src/access-auth.js';
import { handleWebRequest } from '../apps/web/src/app.js';
import { handleOutboundBatch } from '../apps/jobs/src/outbound-consumer.js';
import {
  PermanentOutboundError,
  RetryableOutboundError,
} from '../apps/jobs/src/outbound-errors.js';
import { recoverOutboundDeliveries } from '../apps/jobs/src/outbound-recovery.js';
import type {
  OutboundMailer,
  OutboundMailerMessage,
} from '../apps/jobs/src/outbound-mailer.js';

const ORIGIN = 'https://webmail.example.com';
const NOW = Date.UTC(2026, 6, 16, 16);
const USER_ID = '019c315c-1f20-7000-8000-000000000511';
const MAILBOX_ID = '019c315c-1f20-7000-8000-000000000512';
const VIEWER_ID = '019c315c-1f20-7000-8000-000000000516';
const SOURCE_ID = '019c315c-1f20-7000-8000-000000000520';
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
    const sourcePrefix = `mailboxes/${MAILBOX_ID}/messages/${SOURCE_ID}`;
    const raw = await env.RAW_EMAILS.put(`${sourcePrefix}/raw.eml`, 'reply source');
    if (raw === null) throw new Error('expected source R2 object metadata');
    await env.RAW_EMAILS.put(`${sourcePrefix}/body.txt`, 'original body');
    await persistInboundMessage(env.DB, {
      id: SOURCE_ID,
      mailboxId: MAILBOX_ID,
      status: 'ready',
      processingError: '',
      envelopeFrom: 'original@example.net',
      deliveredTo: 'sender@example.com',
      rfcMessageId: '<original-message@example.net>',
      inReplyTo: '<older-message@example.net>',
      referencesHeader: '<root-message@example.net> <older-message@example.net>',
      subject: 'Original subject',
      sender: 'Original Sender <original@example.net>',
      recipients: 'sender@example.com',
      cc: '',
      replyTo: '',
      dateHeader: 'Thu, 16 Jul 2026 15:00:00 GMT',
      receivedAt: NOW - 60_000,
      textPreview: 'original body',
      rawKey: `${sourcePrefix}/raw.eml`,
      rawSha256: 'c'.repeat(64),
      rawEtag: raw.etag,
      rawSize: 12,
      bodyTextKey: `${sourcePrefix}/body.txt`,
      bodyHtmlKey: null,
      attachments: [],
      createdAt: NOW - 60_000,
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
    const search = await handleWebRequest(new Request(
      `${ORIGIN}/api/mailboxes/${MAILBOX_ID}/messages?folder=outbox&to=hidden%40example.net`,
    ), env, {
      authenticate: async () => ({ ok: true, identity: IDENTITY }),
      now: () => NOW + 2_000,
    });
    await expect(search.json()).resolves.toMatchObject({
      data: { messages: [{ id: firstPayload.data.messageId }] },
    });
  });

  it('sends stored text and HTML through the provider and finishes once', async () => {
    const created = await compose('019c315c-1f20-7000-8000-000000000514', 'Successful message');
    const payload = await created.json<{ data: { messageId: string } }>();
    const send = vi.fn(async (_builder: OutboundMailerMessage) => ({
      messageId: '<provider-success@example.com>',
    }));
    const first = queueItem(payload.data.messageId);
    await handleOutboundBatch([first.item], {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      mailer: testMailer(send),
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
      mailer: testMailer(send),
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

  it('derives reply threading from an authorized source and sends the headers', async () => {
    const created = await compose(
      '019c315c-1f20-7000-8000-000000000521',
      'Re: Original subject',
      IDENTITY,
      ORIGIN,
      { composeMode: 'reply', sourceMessageId: SOURCE_ID },
    );
    expect(created.status).toBe(202);
    const payload = await created.json<{ data: { messageId: string } }>();
    const row = await env.DB.prepare(`
      SELECT m.in_reply_to, m.references_header,
        oc.compose_mode, oc.source_message_id
      FROM messages AS m
      JOIN outbound_compositions AS oc ON oc.message_id = m.id
      WHERE m.id = ?
    `).bind(payload.data.messageId).first<Record<string, string>>();
    expect(row).toEqual({
      in_reply_to: '<original-message@example.net>',
      references_header: '<root-message@example.net> <older-message@example.net> <original-message@example.net>',
      compose_mode: 'reply',
      source_message_id: SOURCE_ID,
    });
    const raw = await env.RAW_EMAILS.get(
      `mailboxes/${MAILBOX_ID}/messages/${payload.data.messageId}/raw.eml`,
    );
    await expect(raw?.text()).resolves.toContain('In-Reply-To: <original-message@example.net>');

    const send = vi.fn(async (_builder: OutboundMailerMessage) => ({
      messageId: '<provider-reply@example.com>',
    }));
    const queued = queueItem(payload.data.messageId);
    await handleOutboundBatch([queued.item], {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      mailer: testMailer(send),
      now: () => NOW + 90_000,
    });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      headers: {
        'In-Reply-To': '<original-message@example.net>',
        References: '<root-message@example.net> <older-message@example.net> <original-message@example.net>',
      },
    });
  });

  it('records forward provenance without incorrectly threading it as a reply', async () => {
    const created = await compose(
      '019c315c-1f20-7000-8000-000000000522',
      'Fwd: Original subject',
      IDENTITY,
      ORIGIN,
      { composeMode: 'forward', sourceMessageId: SOURCE_ID },
    );
    expect(created.status).toBe(202);
    const payload = await created.json<{ data: { messageId: string } }>();
    const row = await env.DB.prepare(`
      SELECT m.in_reply_to, m.references_header,
        oc.compose_mode, oc.source_message_id
      FROM messages AS m
      JOIN outbound_compositions AS oc ON oc.message_id = m.id
      WHERE m.id = ?
    `).bind(payload.data.messageId).first<Record<string, string>>();
    expect(row).toEqual({
      in_reply_to: '',
      references_header: '',
      compose_mode: 'forward',
      source_message_id: SOURCE_ID,
    });
  });

  it('archives, indexes, and sends bounded binary attachments from R2', async () => {
    const files = [
      new File(['attachment payload'], 'report 日本語.txt', { type: 'text/plain' }),
      new File([new Uint8Array([0, 1, 2, 253, 254, 255])], 'pixels.bin', {
        type: 'application/octet-stream',
      }),
    ];
    const created = await composeMultipart(
      '019c315c-1f20-7000-8000-000000000525',
      'Message with attachments',
      files,
    );
    expect(created.status).toBe(202);
    const payload = await created.json<{ data: { messageId: string } }>();
    const message = await env.DB.prepare(`
      SELECT attachment_count, raw_key, raw_size
      FROM messages WHERE id = ?
    `).bind(payload.data.messageId).first<{
      attachment_count: number;
      raw_key: string;
      raw_size: number;
    }>();
    expect(message?.attachment_count).toBe(2);
    expect(message?.raw_key).toMatch(/raw\.eml\.gz$/u);
    expect(message?.raw_size).toBeGreaterThan(0);

    const attachmentRows = await env.DB.prepare(`
      SELECT ordinal, filename, content_type, size, sha256, storage_key
      FROM attachments WHERE message_id = ? ORDER BY ordinal
    `).bind(payload.data.messageId).all<Record<string, string | number>>();
    expect(attachmentRows.results).toHaveLength(2);
    expect(attachmentRows.results[0]).toMatchObject({
      ordinal: 0,
      filename: 'report 日本語.txt',
      content_type: 'text/plain',
      size: 18,
    });
    const search = await handleWebRequest(new Request(
      `${ORIGIN}/api/mailboxes/${MAILBOX_ID}/messages?folder=outbox&q=report`,
    ), env, {
      authenticate: async () => ({ ok: true, identity: IDENTITY }),
      now: () => NOW + 1_000,
    });
    await expect(search.json()).resolves.toMatchObject({
      data: { messages: [{ id: payload.data.messageId }] },
    });
    const stored = await env.RAW_EMAILS.get(String(attachmentRows.results[1]?.storage_key));
    expect(Array.from(new Uint8Array(await stored!.arrayBuffer()))).toEqual([0, 1, 2, 253, 254, 255]);

    const rawDownload = await handleWebRequest(new Request(
      `${ORIGIN}/api/messages/${payload.data.messageId}/raw`,
    ), env, {
      authenticate: async () => ({ ok: true, identity: IDENTITY }),
      now: () => NOW + 1_000,
    });
    const rawText = new TextDecoder().decode(await rawDownload.arrayBuffer());
    expect(rawText).toContain("filename*=UTF-8''report%20%E6%97%A5%E6%9C%AC%E8%AA%9E.txt");
    expect(rawText).toContain('YXR0YWNobWVudCBwYXlsb2Fk');

    const send = vi.fn(async (_builder: OutboundMailerMessage) => ({
      messageId: '<provider-attachments@example.com>',
    }));
    const queued = queueItem(payload.data.messageId);
    await handleOutboundBatch([queued.item], {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      mailer: testMailer(send),
      now: () => NOW + 100_000,
    });
    const sentAttachments = send.mock.calls[0]?.[0].attachments;
    expect(sentAttachments).toHaveLength(2);
    expect(sentAttachments?.[0]).toMatchObject({
      disposition: 'attachment',
      filename: 'report 日本語.txt',
      type: 'text/plain',
    });
    expect(new TextDecoder().decode(sentAttachments?.[0]?.content as ArrayBuffer))
      .toBe('attachment payload');
    expect(Array.from(new Uint8Array(sentAttachments?.[1]?.content as ArrayBuffer)))
      .toEqual([0, 1, 2, 253, 254, 255]);
  });

  it('rejects prohibited attachment types and excessive file counts', async () => {
    const prohibited = await composeMultipart(
      '019c315c-1f20-7000-8000-000000000526',
      'Prohibited attachment',
      [new File(['echo unsafe'], 'run.cmd', { type: 'text/plain' })],
    );
    expect(prohibited.status).toBe(400);
    const excessive = await composeMultipart(
      '019c315c-1f20-7000-8000-000000000527',
      'Too many attachments',
      Array.from({ length: 9 }, (_, index) => new File([], `empty-${index}.txt`)),
    );
    expect(excessive.status).toBe(400);
  });

  it('fails permanently before sending when an R2 attachment loses integrity', async () => {
    const created = await composeMultipart(
      '019c315c-1f20-7000-8000-000000000528',
      'Corrupted attachment',
      [new File(['original'], 'integrity.txt', { type: 'text/plain' })],
    );
    const payload = await created.json<{ data: { messageId: string } }>();
    const attachment = await env.DB.prepare(`
      SELECT storage_key FROM attachments WHERE message_id = ? AND ordinal = 0
    `).bind(payload.data.messageId).first<{ storage_key: string }>();
    await env.RAW_EMAILS.put(attachment!.storage_key, 'tampered');
    const send = vi.fn(async (_builder: OutboundMailerMessage) => ({
      messageId: '<must-not-send@example.com>',
    }));
    const queued = queueItem(payload.data.messageId);
    await handleOutboundBatch([queued.item], {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      mailer: testMailer(send),
      now: () => NOW + 110_000,
    });
    expect(send).not.toHaveBeenCalled();
    expect(queued.ack).toHaveBeenCalledOnce();
    const delivery = await env.DB.prepare(`
      SELECT status, last_error_code FROM outbound_deliveries WHERE message_id = ?
    `).bind(payload.data.messageId).first<Record<string, string>>();
    expect(delivery).toEqual({
      status: 'failed',
      last_error_code: 'attachment_integrity_failed',
    });
  });

  it('rejects forged or contradictory source-message relationships', async () => {
    const missing = await compose(
      '019c315c-1f20-7000-8000-000000000523',
      'Forged reply',
      IDENTITY,
      ORIGIN,
      {
        composeMode: 'reply',
        sourceMessageId: '019c315c-1f20-7000-8000-000000009999',
      },
    );
    expect(missing.status).toBe(400);
    const contradictory = await compose(
      '019c315c-1f20-7000-8000-000000000524',
      'Contradictory new message',
      IDENTITY,
      ORIGIN,
      { composeMode: 'new', sourceMessageId: SOURCE_ID },
    );
    expect(contradictory.status).toBe(400);
  });

  it('records permanent provider errors without retrying the Queue message', async () => {
    const created = await compose('019c315c-1f20-7000-8000-000000000515', 'Permanent failure');
    const payload = await created.json<{ data: { messageId: string } }>();
    const failure = new PermanentOutboundError(
      'smtp2go_rejected',
      'sender domain is unavailable',
    );
    const queued = queueItem(payload.data.messageId);
    await handleOutboundBatch([queued.item], {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      mailer: testMailer(vi.fn(async () => { throw failure; })),
      now: () => NOW + 180_000,
    });
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    const row = await env.DB.prepare(`
      SELECT status, last_error_code FROM outbound_deliveries WHERE message_id = ?
    `).bind(payload.data.messageId).first<Record<string, string>>();
    expect(row).toEqual({
      status: 'failed',
      last_error_code: 'smtp2go_rejected',
    });
  });

  it('delays retryable provider errors and retains queued state', async () => {
    const created = await compose('019c315c-1f20-7000-8000-000000000517', 'Retry later');
    const payload = await created.json<{ data: { messageId: string } }>();
    const failure = new RetryableOutboundError('smtp2go_rate_limited', 'rate limited');
    const queued = queueItem(payload.data.messageId);
    await handleOutboundBatch([queued.item], {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      mailer: testMailer(vi.fn(async () => { throw failure; })),
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
      last_error_code: 'smtp2go_rate_limited',
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
  extra: Record<string, unknown> = {},
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
      ...extra,
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

function testMailer(send: OutboundMailer['send']): OutboundMailer {
  return { provider: 'test-provider', send };
}

function composeMultipart(
  idempotencyKey: string,
  subject: string,
  attachments: File[],
): Promise<Response> {
  const form = new FormData();
  form.set('payload', JSON.stringify({
    to: ['recipient@example.net'],
    cc: [],
    bcc: [],
    subject,
    text: '添付ファイル付き本文です。',
    composeMode: 'new',
    sourceMessageId: null,
  }));
  for (const attachment of attachments) form.append('attachments', attachment);
  return handleWebRequest(new Request(`${ORIGIN}/api/mailboxes/${MAILBOX_ID}/messages`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'idempotency-key': idempotencyKey },
    body: form,
  }), env, {
    authenticate: async () => ({ ok: true, identity: IDENTITY }),
    now: () => NOW + 1_000,
  });
}
