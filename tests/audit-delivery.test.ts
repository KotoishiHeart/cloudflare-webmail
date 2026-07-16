import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  grantSystemAdministrator,
  persistInboundMessage,
  provisionMailboxWithOwner,
  provisionUserWithIdentity,
  recordDeliveryEventSafely,
} from '@cf-webmail/database';
import type { AccessIdentity } from '../apps/web/src/access-auth.js';
import { handleWebRequest } from '../apps/web/src/app.js';

const ORIGIN = 'https://webmail.example.com';
const NOW = Date.UTC(2026, 6, 17, 7);
const USER_ID = '019c315c-1f20-7000-8000-000000000c01';
const MAILBOX_ID = '019c315c-1f20-7000-8000-000000000c02';
const MESSAGE_ID = '019c315c-1f20-7000-8000-000000000c03';
const IDENTITY: AccessIdentity = {
  issuer: 'https://team.cloudflareaccess.com',
  subject: 'audit-owner',
  email: 'audit-owner@example.com',
};

describe('audit and delivery events', () => {
  beforeAll(async () => {
    await provisionUserWithIdentity(env.DB, {
      userId: USER_ID, email: IDENTITY.email, identity: IDENTITY, now: NOW,
    });
    await grantSystemAdministrator(env.DB, { userId: USER_ID, now: NOW });
    await provisionMailboxWithOwner(env.DB, {
      mailboxId: MAILBOX_ID, ownerUserId: USER_ID,
      address: 'audit@example.com', displayName: 'Audit mailbox', now: NOW,
    });
    await persistInboundMessage(env.DB, {
      id: MESSAGE_ID, mailboxId: MAILBOX_ID, status: 'ready', processingError: '',
      envelopeFrom: 'sender@example.net', deliveredTo: 'audit@example.com',
      rfcMessageId: '<audit@example.net>', inReplyTo: '', referencesHeader: '',
      subject: 'Audit fixture', sender: 'sender@example.net', recipients: 'audit@example.com',
      cc: '', replyTo: '', dateHeader: 'Fri, 17 Jul 2026 07:00:00 GMT',
      receivedAt: NOW, textPreview: 'audit',
      rawKey: `mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}/raw.eml`,
      rawSha256: 'e'.repeat(64), rawEtag: 'audit-etag', rawSize: 5,
      bodyTextKey: null, bodyHtmlKey: null, attachments: [], createdAt: NOW,
    });
  });

  it('exposes only an explicitly provisioned system administrator flag', async () => {
    const response = await api('/api/session');
    await expect(response.json()).resolves.toMatchObject({
      data: { user: { email: IDENTITY.email, isSystemAdmin: true } },
    });
  });

  it('records authenticated mutations with a redacted route and request context', async () => {
    const response = await api(`/api/messages/${MESSAGE_ID}`, {
      method: 'PATCH', body: { isDeleted: true },
    });
    expect(response.status).toBe(200);
    const message = await env.DB.prepare(
      'SELECT is_deleted, deleted_at FROM messages WHERE id = ?',
    ).bind(MESSAGE_ID).first<{ is_deleted: number; deleted_at: number | null }>();
    expect(message).toEqual({ is_deleted: 1, deleted_at: NOW + 10 });
    const event = await env.DB.prepare(`
      SELECT actor_user_id, mailbox_id, category, action, target_id, details_json
      FROM audit_events WHERE target_id = ? ORDER BY created_at DESC LIMIT 1
    `).bind(MESSAGE_ID).first<Record<string, unknown>>();
    expect(event).toMatchObject({
      actor_user_id: USER_ID,
      category: 'message',
      action: 'message.patch',
      target_id: MESSAGE_ID,
    });
    expect(String(event?.details_json)).toContain('/api/messages/:id');

    await api(`/api/messages/${MESSAGE_ID}`, {
      method: 'PATCH', body: { isDeleted: false },
    });
    await expect(env.DB.prepare(
      'SELECT is_deleted, deleted_at FROM messages WHERE id = ?',
    ).bind(MESSAGE_ID).first()).resolves.toEqual({ is_deleted: 0, deleted_at: null });
  });

  it('stores bounded delivery diagnostics without message content', async () => {
    await recordDeliveryEventSafely(env.DB, {
      direction: 'inbound', stage: 'completed', status: 'succeeded',
      category: 'message_stored', mailboxId: MAILBOX_ID, messageId: MESSAGE_ID,
      summary: 'Inbound message stored', details: { quarantined: false }, now: NOW + 20,
    });
    const event = await env.DB.prepare(`
      SELECT direction, stage, status, category, summary, details_json
      FROM delivery_events WHERE message_id = ? ORDER BY created_at DESC LIMIT 1
    `).bind(MESSAGE_ID).first<Record<string, unknown>>();
    expect(event).toMatchObject({
      direction: 'inbound', stage: 'completed', status: 'succeeded',
      category: 'message_stored', summary: 'Inbound message stored',
    });
    expect(String(event?.details_json)).toBe('{"quarantined":false}');
  });
});

function api(
  path: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
): Promise<Response> {
  const method = options.method ?? 'GET';
  return handleWebRequest(new Request(`${ORIGIN}${path}`, {
    method,
    headers: method === 'GET' ? {} : {
      origin: ORIGIN,
      'content-type': 'application/json',
      'cf-ray': 'audit-test-ray',
      'cf-connecting-ip': '192.0.2.1',
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }), env, {
    authenticate: async () => ({ ok: true, identity: IDENTITY }),
    now: () => NOW + 10,
  });
}
