import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  persistInboundMessage,
  provisionMailboxWithOwner,
  provisionUserWithIdentity,
  setMailboxMembership,
} from '@cf-webmail/database';
import type { AccessIdentity } from '../apps/web/src/access-auth.js';
import { handleWebRequest } from '../apps/web/src/app.js';

const ORIGIN = 'https://webmail.example.com';
const NOW = Date.UTC(2026, 6, 17, 3);
const OWNER_ID = '019c315c-1f20-7000-8000-000000000901';
const VIEWER_ID = '019c315c-1f20-7000-8000-000000000902';
const MAILBOX_ID = '019c315c-1f20-7000-8000-000000000903';
const OTHER_MAILBOX_ID = '019c315c-1f20-7000-8000-000000000904';
const MESSAGE_ID = '019c315c-1f20-7000-8000-000000000905';

const OWNER: AccessIdentity = {
  issuer: 'https://team.cloudflareaccess.com',
  subject: 'label-owner',
  email: 'label-owner@example.com',
};
const VIEWER: AccessIdentity = {
  issuer: OWNER.issuer,
  subject: 'label-viewer',
  email: 'label-viewer@example.com',
};

describe('mailbox labels and user preferences', () => {
  beforeAll(async () => {
    await provisionUserWithIdentity(env.DB, {
      userId: OWNER_ID,
      email: OWNER.email,
      identity: OWNER,
      now: NOW,
    });
    await provisionUserWithIdentity(env.DB, {
      userId: VIEWER_ID,
      email: VIEWER.email,
      identity: VIEWER,
      now: NOW,
    });
    await provisionMailboxWithOwner(env.DB, {
      mailboxId: MAILBOX_ID,
      ownerUserId: OWNER_ID,
      address: 'labels@example.com',
      displayName: 'Labels inbox',
      now: NOW,
    });
    await provisionMailboxWithOwner(env.DB, {
      mailboxId: OTHER_MAILBOX_ID,
      ownerUserId: OWNER_ID,
      address: 'other-labels@example.com',
      displayName: 'Other labels inbox',
      now: NOW,
    });
    await setMailboxMembership(env.DB, {
      mailboxId: MAILBOX_ID,
      userId: VIEWER_ID,
      role: 'viewer',
      now: NOW + 1,
    });
    const prefix = `mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}`;
    const raw = await env.RAW_EMAILS.put(`${prefix}/raw.eml`, 'label fixture');
    if (raw === null) throw new Error('expected label fixture R2 metadata');
    await persistInboundMessage(env.DB, {
      id: MESSAGE_ID,
      mailboxId: MAILBOX_ID,
      status: 'ready',
      processingError: '',
      envelopeFrom: 'sender@example.net',
      deliveredTo: 'labels@example.com',
      rfcMessageId: '<labels-fixture@example.net>',
      inReplyTo: '',
      referencesHeader: '',
      subject: 'Label fixture',
      sender: 'Sender <sender@example.net>',
      recipients: 'labels@example.com',
      cc: '',
      replyTo: '',
      dateHeader: 'Fri, 17 Jul 2026 03:00:00 GMT',
      receivedAt: NOW,
      textPreview: 'label fixture',
      rawKey: `${prefix}/raw.eml`,
      rawSha256: 'd'.repeat(64),
      rawEtag: raw.etag,
      rawSize: 13,
      bodyTextKey: null,
      bodyHtmlKey: null,
      attachments: [],
      createdAt: NOW,
    });
  });

  it('creates mailbox-scoped labels and exposes them to readers', async () => {
    const created = await api(`/api/mailboxes/${MAILBOX_ID}/labels`, OWNER, {
      method: 'POST',
      body: { name: '重要', color: '#dc2626', description: '優先対応' },
    });
    expect(created.status).toBe(201);
    const payload = await created.json<{ data: { label: { id: string } } }>();
    expect(payload.data.label).toMatchObject({
      mailboxId: MAILBOX_ID,
      name: '重要',
      color: '#dc2626',
      messageCount: 0,
    });

    const list = await api(`/api/mailboxes/${MAILBOX_ID}/labels`, VIEWER);
    await expect(list.json()).resolves.toMatchObject({
      data: { labels: [{ id: payload.data.label.id, name: '重要' }] },
    });
    const duplicate = await api(`/api/mailboxes/${MAILBOX_ID}/labels`, OWNER, {
      method: 'POST',
      body: { name: '重要', color: '#000000' },
    });
    expect(duplicate.status).toBe(400);
  });

  it('allows operators to replace manual labels but rejects viewers and foreign labels', async () => {
    const primary = await createLabel(MAILBOX_ID, '顧客', '#2563eb');
    const foreign = await createLabel(OTHER_MAILBOX_ID, '別箱', '#16a34a');
    const viewer = await api(`/api/messages/${MESSAGE_ID}/labels`, VIEWER, {
      method: 'PUT',
      body: { labelIds: [primary] },
    });
    expect(viewer.status).toBe(403);

    const crossMailbox = await api(`/api/messages/${MESSAGE_ID}/labels`, OWNER, {
      method: 'PUT',
      body: { labelIds: [foreign] },
    });
    expect(crossMailbox.status).toBe(400);

    const assigned = await api(`/api/messages/${MESSAGE_ID}/labels`, OWNER, {
      method: 'PUT',
      body: { labelIds: [primary] },
    });
    expect(assigned.status).toBe(200);
    await expect(assigned.json()).resolves.toMatchObject({
      data: { labels: [{ id: primary, name: '顧客' }] },
    });
    const detail = await api(`/api/messages/${MESSAGE_ID}`, VIEWER);
    await expect(detail.json()).resolves.toMatchObject({
      data: { labels: [{ id: primary, name: '顧客' }] },
    });
    const filtered = await api(
      `/api/mailboxes/${MAILBOX_ID}/messages?folder=inbox&label=${primary}`,
      VIEWER,
    );
    await expect(filtered.json()).resolves.toMatchObject({
      data: { messages: [{ id: MESSAGE_ID, labels: [{ id: primary }] }] },
    });
  });

  it('restricts shared label management to owners and cascades label removal', async () => {
    const labelId = await createLabel(MAILBOX_ID, '一時', '#9333ea');
    await api(`/api/messages/${MESSAGE_ID}/labels`, OWNER, {
      method: 'PUT',
      body: { labelIds: [labelId] },
    });
    const viewerPatch = await api(`/api/mailboxes/${MAILBOX_ID}/labels/${labelId}`, VIEWER, {
      method: 'PATCH',
      body: { name: '変更不可' },
    });
    expect(viewerPatch.status).toBe(403);
    const patched = await api(`/api/mailboxes/${MAILBOX_ID}/labels/${labelId}`, OWNER, {
      method: 'PATCH',
      body: { name: '処理済み', description: '完了したメール' },
    });
    await expect(patched.json()).resolves.toMatchObject({
      data: { label: { name: '処理済み', color: '#9333ea' } },
    });
    const removed = await api(`/api/mailboxes/${MAILBOX_ID}/labels/${labelId}`, OWNER, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect(await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM message_labels WHERE label_id = ?',
    ).bind(labelId).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it('persists validated preferences per Access-linked user', async () => {
    const defaults = await api('/api/preferences', OWNER);
    await expect(defaults.json()).resolves.toMatchObject({
      data: {
        preferences: {
          theme: 'system',
          pageSize: 30,
          defaultFolder: 'inbox',
          defaultMailboxId: null,
          showHtmlByDefault: true,
          compactLayout: false,
        },
      },
    });
    const updated = await api('/api/preferences', OWNER, {
      method: 'PATCH',
      body: {
        theme: 'dark',
        pageSize: 20,
        defaultFolder: 'starred',
        defaultMailboxId: OTHER_MAILBOX_ID,
        showHtmlByDefault: false,
        compactLayout: true,
      },
    });
    expect(updated.status).toBe(200);
    const again = await api('/api/preferences', OWNER);
    await expect(again.json()).resolves.toMatchObject({
      data: { preferences: {
        theme: 'dark', pageSize: 20, defaultFolder: 'starred',
        defaultMailboxId: OTHER_MAILBOX_ID,
      } },
    });
    const viewerDefaults = await api('/api/preferences', VIEWER);
    await expect(viewerDefaults.json()).resolves.toMatchObject({
      data: { preferences: { theme: 'system', pageSize: 30 } },
    });
  });

  it('rejects invalid preferences and cross-origin mutations', async () => {
    const invalid = await api('/api/preferences', OWNER, {
      method: 'PATCH',
      body: { pageSize: 200 },
    });
    expect(invalid.status).toBe(400);
    const unauthorizedMailbox = await api('/api/preferences', VIEWER, {
      method: 'PATCH',
      body: { defaultMailboxId: OTHER_MAILBOX_ID },
    });
    expect(unauthorizedMailbox.status).toBe(400);
    const crossOrigin = await api('/api/preferences', OWNER, {
      method: 'PATCH',
      origin: 'https://attacker.example',
      body: { theme: 'light' },
    });
    expect(crossOrigin.status).toBe(403);
  });
});

async function createLabel(mailboxId: string, name: string, color: string): Promise<string> {
  const response = await api(`/api/mailboxes/${mailboxId}/labels`, OWNER, {
    method: 'POST',
    body: { name, color },
  });
  const payload = await response.json<{ data: { label: { id: string } } }>();
  return payload.data.label.id;
}

function api(
  path: string,
  identity: AccessIdentity,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    origin?: string;
  } = {},
): Promise<Response> {
  const method = options.method ?? 'GET';
  return handleWebRequest(new Request(`${ORIGIN}${path}`, {
    method,
    headers: method === 'GET' ? {} : {
      origin: options.origin ?? ORIGIN,
      'content-type': 'application/json',
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }), env, {
    authenticate: async () => ({ ok: true, identity }),
    now: () => NOW + 10_000,
  });
}
