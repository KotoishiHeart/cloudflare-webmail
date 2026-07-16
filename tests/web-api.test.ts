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
const ISSUER = 'https://team.cloudflareaccess.com';
const NOW = Date.UTC(2026, 6, 16, 14);
const OWNER_ID = '019c315c-1f20-7000-8000-000000000301';
const VIEWER_ID = '019c315c-1f20-7000-8000-000000000302';
const MAILBOX_ID = '019c315c-1f20-7000-8000-000000000303';
const MESSAGE_ID = '019c315c-1f20-7000-8000-000000000304';
const PREFIX = `mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}`;

const OWNER: AccessIdentity = {
  issuer: ISSUER,
  subject: 'web-owner',
  email: 'web-owner@example.com',
};
const VIEWER: AccessIdentity = {
  issuer: ISSUER,
  subject: 'web-viewer',
  email: 'web-viewer@example.com',
};

describe('authorized webmail API', () => {
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
      address: 'web-inbox@example.com',
      displayName: 'Web inbox',
      now: NOW,
    });
    await setMailboxMembership(env.DB, {
      mailboxId: MAILBOX_ID,
      userId: VIEWER_ID,
      role: 'viewer',
      now: NOW + 1,
    });
    const raw = await env.RAW_EMAILS.put(`${PREFIX}/raw.eml`, 'raw web message');
    if (raw === null) throw new Error('expected raw R2 object metadata');
    await env.RAW_EMAILS.put(`${PREFIX}/body.txt`, 'hello from the web API');
    await env.RAW_EMAILS.put(`${PREFIX}/attachments/000`, 'notes file');
    await persistInboundMessage(env.DB, {
      id: MESSAGE_ID,
      mailboxId: MAILBOX_ID,
      status: 'ready',
      processingError: '',
      envelopeFrom: 'sender@example.net',
      deliveredTo: 'web-inbox@example.com',
      rfcMessageId: '<web-api@example.net>',
      inReplyTo: '',
      referencesHeader: '',
      subject: 'Web API message',
      sender: 'Sender <sender@example.net>',
      recipients: 'web-inbox@example.com',
      cc: '',
      replyTo: '',
      dateHeader: 'Thu, 16 Jul 2026 14:00:00 GMT',
      receivedAt: NOW,
      textPreview: 'hello from the web API',
      rawKey: `${PREFIX}/raw.eml`,
      rawSha256: 'a'.repeat(64),
      rawEtag: raw.etag,
      rawSize: 15,
      bodyTextKey: `${PREFIX}/body.txt`,
      bodyHtmlKey: null,
      attachments: [{
        ordinal: 0,
        filename: 'notes 日本語.txt',
        contentType: 'text/plain',
        disposition: 'attachment',
        contentId: '',
        size: 10,
        sha256: 'b'.repeat(64),
        storageKey: `${PREFIX}/attachments/000`,
        createdAt: NOW,
      }],
      createdAt: NOW,
    });
  });

  it('returns only mailboxes linked to the verified Access identity', async () => {
    const response = await webRequest('/api/session', {}, OWNER);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        user: { email: OWNER.email },
        mailboxes: [{ id: MAILBOX_ID, role: 'owner', address: 'web-inbox@example.com' }],
      },
    });
  });

  it('lists and reads a message without exposing internal R2 keys', async () => {
    const list = await webRequest(`/api/mailboxes/${MAILBOX_ID}/messages?folder=inbox`, {}, OWNER);
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).toContain('Web API message');
    expect(listText).not.toContain(PREFIX);

    const detail = await webRequest(`/api/messages/${MESSAGE_ID}`, {}, OWNER);
    expect(detail.status).toBe(200);
    const detailText = await detail.text();
    expect(detailText).toContain(`/api/messages/${MESSAGE_ID}/body`);
    expect(detailText).toContain('notes 日本語.txt');
    expect(detailText).not.toContain(PREFIX);
  });

  it('streams body, raw MIME, and attachment objects after authorization', async () => {
    const body = await webRequest(`/api/messages/${MESSAGE_ID}/body`, {}, VIEWER);
    expect(body.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    await expect(body.text()).resolves.toBe('hello from the web API');

    const raw = await webRequest(`/api/messages/${MESSAGE_ID}/raw`, {}, OWNER);
    expect(raw.headers.get('content-disposition')).toContain(`${MESSAGE_ID}.eml`);
    expect(new TextDecoder().decode(await raw.arrayBuffer())).toBe('raw web message');

    const attachment = await webRequest(
      `/api/messages/${MESSAGE_ID}/attachments/0`,
      {},
      OWNER,
    );
    expect(attachment.headers.get('content-type')).toBe('application/octet-stream');
    expect(attachment.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(new TextDecoder().decode(await attachment.arrayBuffer())).toBe('notes file');
  });

  it('allows operators to change flags but rejects viewers and cross-origin requests', async () => {
    const viewer = await patchFlags(VIEWER, { isRead: true });
    expect(viewer.status).toBe(403);
    const crossOrigin = await patchFlags(OWNER, { isRead: true }, 'https://attacker.example');
    expect(crossOrigin.status).toBe(403);

    const owner = await patchFlags(OWNER, { isRead: true, isStarred: true });
    expect(owner.status).toBe(200);
    await expect(owner.json()).resolves.toMatchObject({
      data: { message: { id: MESSAGE_ID, isRead: true, isStarred: true } },
    });
  });

  it('returns not found for identities that are not mailbox members', async () => {
    const outsider = { ...OWNER, subject: 'not-linked' };
    const response = await webRequest(`/api/messages/${MESSAGE_ID}`, {}, outsider);
    expect(response.status).toBe(404);
  });
});

function webRequest(
  path: string,
  init: RequestInit,
  identity: AccessIdentity,
): Promise<Response> {
  return handleWebRequest(new Request(`${ORIGIN}${path}`, init), env, {
    authenticate: async () => ({ ok: true, identity }),
    now: () => NOW + 10,
  });
}

function patchFlags(
  identity: AccessIdentity,
  patch: Record<string, boolean>,
  origin = ORIGIN,
): Promise<Response> {
  return webRequest(`/api/messages/${MESSAGE_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(patch),
  }, identity);
}
