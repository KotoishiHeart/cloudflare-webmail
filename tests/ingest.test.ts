import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_INBOUND_MESSAGE_BYTES } from '@cf-webmail/contracts';
import {
  addMailboxAlias,
  provisionMailboxWithOwner,
  provisionUserWithIdentity,
} from '@cf-webmail/database';
import {
  handleInboundEmail,
  INVALID_MESSAGE_REASON,
  PROCESSING_FAILURE_REASON,
  UNKNOWN_RECIPIENT_REASON,
  type InboundEmail,
} from '../apps/ingest/src/email-handler.js';

const NOW = Date.UTC(2026, 6, 16, 12);
const USER_ID = '019c315c-1f20-7000-8000-000000000101';
const MAILBOX_ID = '019c315c-1f20-7000-8000-000000000102';
const PRIMARY_ADDRESS = 'inbound-primary@example.com';
const ALIAS_ADDRESS = 'inbound-alias@example.com';

describe('Email Routing durable handoff', () => {
  beforeAll(async () => {
    await provisionUserWithIdentity(env.DB, {
      userId: USER_ID,
      email: 'inbound-owner@example.com',
      identity: {
        issuer: 'https://team.cloudflareaccess.com',
        subject: 'inbound-owner',
      },
      now: NOW,
    });
    await provisionMailboxWithOwner(env.DB, {
      mailboxId: MAILBOX_ID,
      ownerUserId: USER_ID,
      address: PRIMARY_ADDRESS,
      now: NOW,
    });
    await addMailboxAlias(env.DB, {
      mailboxId: MAILBOX_ID,
      address: ALIAS_ADDRESS,
      now: NOW + 1,
    });
  });

  it('streams raw mail to R2 before producing the Queue contract', async () => {
    const rawText = [
      'From: sender@example.net',
      `To: ${ALIAS_ADDRESS}`,
      'Subject: durable handoff',
      'Message-ID: <durable@example.net>',
      '',
      'hello',
    ].join('\r\n');
    const { message, setReject } = createEmail(rawText, { from: '', to: ALIAS_ADDRESS });
    const enqueue = vi.fn(async () => {});

    const result = await handleInboundEmail(message, {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      enqueue,
    }, {
      messageId: '019c315c-1f20-7000-8000-000000000103',
      receivedAt: NOW,
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error('expected accepted inbound message');
    expect(setReject).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(result.queueMessage);
    expect(result.rawKey).toBe(
      `staging/raw/2026/07/16/${MAILBOX_ID}/019c315c-1f20-7000-8000-000000000103.eml`,
    );
    expect(result.queueMessage).toMatchObject({
      envelope: { from: '', to: ALIAS_ADDRESS },
      accountEmail: PRIMARY_ADDRESS,
      headers: { subject: 'durable handoff', messageId: '<durable@example.net>' },
      routing: { action: 'store', policy: 'active-mailbox-v1' },
    });

    const stored = await env.RAW_EMAILS.get(result.rawKey);
    expect(stored).not.toBeNull();
    if (stored === null) throw new Error('expected staged R2 object');
    expect(await stored.text()).toBe(rawText);
    expect(stored.httpMetadata?.contentType).toBe('message/rfc822');
    expect(stored.customMetadata).toMatchObject({
      schemaVersion: '2',
      messageId: result.queueMessage.messageId,
      mailboxId: MAILBOX_ID,
      receivedAt: String(NOW),
      rawSize: String(result.queueMessage.staging.rawSize),
    });
  });

  it('rejects an unknown recipient before reading or staging the body', async () => {
    const { message, setReject } = createEmail('unread body', {
      from: 'sender@example.net',
      to: 'unknown-inbound@example.com',
    });
    const enqueue = vi.fn(async () => {});

    const result = await handleInboundEmail(message, {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      enqueue,
    }, {
      messageId: '019c315c-1f20-7000-8000-000000000104',
      receivedAt: NOW,
    });

    expect(result).toEqual({
      accepted: false,
      code: 'unknown-recipient',
      reason: UNKNOWN_RECIPIENT_REASON,
    });
    expect(setReject).toHaveBeenCalledWith(UNKNOWN_RECIPIENT_REASON);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a declared body size above the Email Routing limit', async () => {
    const { message, setReject } = createEmail('small body', {
      from: 'sender@example.net',
      to: ALIAS_ADDRESS,
      rawSize: MAX_INBOUND_MESSAGE_BYTES + 1,
    });
    const enqueue = vi.fn(async () => {});

    const result = await handleInboundEmail(message, {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      enqueue,
    }, {
      messageId: '019c315c-1f20-7000-8000-000000000105',
      receivedAt: NOW,
    });

    expect(result).toMatchObject({ accepted: false, code: 'invalid-size' });
    expect(setReject).toHaveBeenCalledWith(INVALID_MESSAGE_REASON);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('retains a recoverable R2 object when Queue production fails', async () => {
    const rawText = 'Subject: recoverable\r\n\r\nbody';
    const { message, setReject } = createEmail(rawText, {
      from: 'sender@example.net',
      to: PRIMARY_ADDRESS,
    });
    const enqueue = vi.fn(async () => {
      throw new Error('simulated Queue failure');
    });

    const result = await handleInboundEmail(message, {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      enqueue,
    }, {
      messageId: '019c315c-1f20-7000-8000-000000000106',
      receivedAt: NOW,
    });

    expect(result).toMatchObject({ accepted: false, code: 'queue-failed' });
    expect(setReject).toHaveBeenCalledWith(PROCESSING_FAILURE_REASON);
    if (result.accepted || result.rawKey === undefined) {
      throw new Error('expected a rejected message with a staged R2 key');
    }
    const stored = await env.RAW_EMAILS.get(result.rawKey);
    expect(stored).not.toBeNull();
    await expect(stored?.text()).resolves.toBe(rawText);
  });

  it('does not enqueue when R2 staging fails', async () => {
    const rawText = 'Subject: unavailable\r\n\r\nbody';
    const { message, setReject } = createEmail(rawText, {
      from: 'sender@example.net',
      to: PRIMARY_ADDRESS,
    });
    const enqueue = vi.fn(async () => {});
    const put: R2Bucket['put'] = async (_key, value) => {
      if (!(value instanceof ReadableStream)) throw new Error('expected a stream');
      await new Response(value).arrayBuffer();
      throw new Error('simulated R2 failure');
    };

    const result = await handleInboundEmail(message, {
      db: env.DB,
      rawEmails: { put },
      enqueue,
    }, {
      messageId: '019c315c-1f20-7000-8000-000000000107',
      receivedAt: NOW,
    });

    expect(result).toMatchObject({ accepted: false, code: 'staging-failed' });
    expect(setReject).toHaveBeenCalledWith(PROCESSING_FAILURE_REASON);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

function createEmail(
  rawText: string,
  envelope: { from: string; to: string; rawSize?: number },
): { message: InboundEmail; setReject: ReturnType<typeof vi.fn> } {
  const bytes = new TextEncoder().encode(rawText);
  const setReject = vi.fn();
  const headers = new Headers();
  for (const line of (rawText.split('\r\n\r\n', 1)[0] ?? '').split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) headers.append(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return {
    message: {
      from: envelope.from,
      to: envelope.to,
      headers,
      raw: new Blob([bytes]).stream(),
      rawSize: envelope.rawSize ?? bytes.byteLength,
      setReject,
    },
    setReject,
  };
}
