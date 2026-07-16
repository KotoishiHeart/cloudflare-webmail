import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  grantSystemAdministrator,
  provisionUserWithIdentity,
} from '@cf-webmail/database';
import type { AccessIdentity } from '../apps/web/src/access-auth.js';
import { handleWebRequest } from '../apps/web/src/app.js';

const ORIGIN = 'https://webmail.example.com';
const NOW = Date.UTC(2026, 6, 17, 8);
const ADMIN_ID = '019c315c-1f20-7000-8000-000000000d01';
const VIEWER_ID = '019c315c-1f20-7000-8000-000000000d02';
const ADMIN: AccessIdentity = {
  issuer: 'https://team.cloudflareaccess.com', subject: 'admin-api', email: 'admin-api@example.com',
};
const VIEWER: AccessIdentity = {
  issuer: ADMIN.issuer, subject: 'admin-viewer', email: 'admin-viewer@example.com',
};

describe('system administration API', () => {
  beforeAll(async () => {
    await provisionUserWithIdentity(env.DB, {
      userId: ADMIN_ID, email: ADMIN.email, identity: ADMIN, now: NOW,
    });
    await grantSystemAdministrator(env.DB, { userId: ADMIN_ID, now: NOW });
    await provisionUserWithIdentity(env.DB, {
      userId: VIEWER_ID, email: VIEWER.email, identity: VIEWER, now: NOW,
    });
  });

  it('requires an explicit system administrator grant', async () => {
    const response = await apiAs(VIEWER, '/api/admin/summary');
    expect(response.status).toBe(403);
  });

  it('creates users and protects the current administrator', async () => {
    const created = await api('/api/admin/users', {
      method: 'POST',
      body: {
        email: 'operator@example.com',
        displayName: 'Operator',
        identity: { issuer: ADMIN.issuer, subject: 'operator' },
      },
    });
    expect(created.status).toBe(201);
    const payload = await created.json() as {
      data: { user: { user: { id: string; email: string } } };
    };
    expect(payload.data.user.user.email).toBe('operator@example.com');

    const selfDisable = await api(`/api/admin/users/${ADMIN_ID}`, {
      method: 'PATCH', body: { status: 'disabled' },
    });
    expect(selfDisable.status).toBe(409);
    const selfRevoke = await api(`/api/admin/users/${ADMIN_ID}/administrator`, {
      method: 'DELETE',
    });
    expect(selfRevoke.status).toBe(409);
  });

  it('manages mailboxes, aliases, and memberships with safety invariants', async () => {
    const created = await api('/api/admin/mailboxes', {
      method: 'POST',
      body: {
        address: 'managed@example.com', displayName: 'Managed mailbox', ownerUserId: ADMIN_ID,
      },
    });
    expect(created.status).toBe(201);
    const payload = await created.json() as {
      data: { mailbox: { mailbox: { id: string } } };
    };
    const mailboxId = payload.data.mailbox.mailbox.id;

    expect((await api(`/api/admin/mailboxes/${mailboxId}/addresses`, {
      method: 'POST', body: { address: 'alias@example.com' },
    })).status).toBe(201);
    expect((await api(`/api/admin/mailboxes/${mailboxId}/members/${VIEWER_ID}`, {
      method: 'PUT', body: { role: 'viewer' },
    })).status).toBe(200);
    expect((await api(`/api/admin/mailboxes/${mailboxId}/members/${ADMIN_ID}`, {
      method: 'DELETE',
    })).status).toBe(409);
    expect((await api(`/api/admin/mailboxes/${mailboxId}/addresses`, {
      method: 'DELETE', body: { address: 'managed@example.com' },
    })).status).toBe(409);
  });

  it('lists structured event pages', async () => {
    const [audit, delivery] = await Promise.all([
      api('/api/admin/audit-events?limit=10'),
      api('/api/admin/delivery-events?limit=10'),
    ]);
    expect(audit.status).toBe(200);
    expect(delivery.status).toBe(200);
    await expect(audit.json()).resolves.toMatchObject({ ok: true });
    await expect(delivery.json()).resolves.toMatchObject({ ok: true });
  });
});

function api(
  path: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
): Promise<Response> {
  return apiAs(ADMIN, path, options);
}

function apiAs(
  identity: AccessIdentity,
  path: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
): Promise<Response> {
  const method = options.method ?? 'GET';
  return handleWebRequest(new Request(`${ORIGIN}${path}`, {
    method,
    headers: method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }), env, {
    authenticate: async () => ({ ok: true, identity }),
    now: () => NOW + 100,
  });
}
