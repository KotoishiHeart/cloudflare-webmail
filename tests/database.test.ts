import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  authorizeMailboxAccess,
  DatabaseInputError,
  listAuthorizedMailboxes,
  mailboxRoleGrants,
  normalizeEmailAddress,
  provisionMailboxWithOwner,
  provisionUserWithIdentity,
  resolveActiveMailboxAddress,
  setMailboxMembership,
} from '@cf-webmail/database';

const NOW = 1_768_435_200_000;
const ISSUER = 'https://team.cloudflareaccess.com';

describe('D1 identity and mailbox authorization', () => {
  it('normalizes addresses and defines hierarchical capabilities', () => {
    expect(normalizeEmailAddress(' Owner@Example.COM ')).toBe('owner@example.com');
    expect(mailboxRoleGrants('viewer', 'read')).toBe(true);
    expect(mailboxRoleGrants('viewer', 'operate')).toBe(false);
    expect(mailboxRoleGrants('operator', 'manage')).toBe(false);
    expect(mailboxRoleGrants('owner', 'manage')).toBe(true);
    expect(() => normalizeEmailAddress('not-an-address')).toThrow(DatabaseInputError);
  });

  it('provisions an owner and resolves its active primary route', async () => {
    const userId = '019c315c-1f20-7000-8000-000000000001';
    const mailboxId = '019c315c-1f20-7000-8000-000000000002';
    await provisionUserWithIdentity(env.DB, {
      userId,
      email: 'Owner@Example.com',
      identity: { issuer: `${ISSUER}/`, subject: 'owner-subject' },
      now: NOW,
    });
    await provisionMailboxWithOwner(env.DB, {
      mailboxId,
      ownerUserId: userId,
      address: 'Inbox@Example.com',
      displayName: 'Main inbox',
      now: NOW,
    });

    await expect(resolveActiveMailboxAddress(env.DB, 'INBOX@example.com')).resolves.toEqual({
      mailboxId,
      address: 'inbox@example.com',
      addressKind: 'primary',
      displayName: 'Main inbox',
    });
    await expect(authorizeMailboxAccess(
      env.DB,
      { issuer: ISSUER, subject: 'owner-subject' },
      mailboxId,
      'manage',
    )).resolves.toEqual({ allowed: true, userId, mailboxId, role: 'owner' });
  });

  it('allows viewers to read but denies mailbox operations', async () => {
    const ownerId = '019c315c-1f20-7000-8000-000000000011';
    const viewerId = '019c315c-1f20-7000-8000-000000000012';
    const mailboxId = '019c315c-1f20-7000-8000-000000000013';
    await provisionUserWithIdentity(env.DB, {
      userId: ownerId,
      email: 'owner-2@example.com',
      identity: { issuer: ISSUER, subject: 'owner-2' },
      now: NOW,
    });
    await provisionUserWithIdentity(env.DB, {
      userId: viewerId,
      email: 'viewer@example.com',
      identity: { issuer: ISSUER, subject: 'viewer' },
      now: NOW,
    });
    await provisionMailboxWithOwner(env.DB, {
      mailboxId,
      ownerUserId: ownerId,
      address: 'shared@example.com',
      now: NOW,
    });
    await setMailboxMembership(env.DB, {
      mailboxId,
      userId: viewerId,
      role: 'viewer',
      now: NOW + 1,
    });

    await expect(authorizeMailboxAccess(
      env.DB,
      { issuer: ISSUER, subject: 'viewer' },
      mailboxId,
      'read',
    )).resolves.toMatchObject({ allowed: true, role: 'viewer' });
    await expect(authorizeMailboxAccess(
      env.DB,
      { issuer: ISSUER, subject: 'viewer' },
      mailboxId,
      'operate',
    )).resolves.toEqual({ allowed: false, reason: 'insufficient-role' });
  });

  it('fails closed for unknown identities and disabled records', async () => {
    const userId = '019c315c-1f20-7000-8000-000000000021';
    const mailboxId = '019c315c-1f20-7000-8000-000000000022';
    await provisionUserWithIdentity(env.DB, {
      userId,
      email: 'disabled@example.com',
      identity: { issuer: ISSUER, subject: 'disabled-user' },
      now: NOW,
    });
    await provisionMailboxWithOwner(env.DB, {
      mailboxId,
      ownerUserId: userId,
      address: 'disabled-inbox@example.com',
      now: NOW,
    });

    await env.DB.prepare("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?")
      .bind(NOW + 1, userId)
      .run();
    await expect(authorizeMailboxAccess(
      env.DB,
      { issuer: ISSUER, subject: 'disabled-user' },
      mailboxId,
      'read',
    )).resolves.toEqual({ allowed: false, reason: 'user-disabled' });
    await expect(authorizeMailboxAccess(
      env.DB,
      { issuer: ISSUER, subject: 'unknown' },
      mailboxId,
      'read',
    )).resolves.toEqual({ allowed: false, reason: 'identity-not-linked' });
    await expect(listAuthorizedMailboxes(
      env.DB,
      { issuer: ISSUER, subject: 'disabled-user' },
    )).resolves.toEqual([]);
  });

  it('rolls back mailbox provisioning when its address is already routed', async () => {
    const userId = '019c315c-1f20-7000-8000-000000000031';
    const firstMailboxId = '019c315c-1f20-7000-8000-000000000032';
    const rejectedMailboxId = '019c315c-1f20-7000-8000-000000000033';
    await provisionUserWithIdentity(env.DB, {
      userId,
      email: 'atomic@example.com',
      identity: { issuer: ISSUER, subject: 'atomic' },
      now: NOW,
    });
    await provisionMailboxWithOwner(env.DB, {
      mailboxId: firstMailboxId,
      ownerUserId: userId,
      address: 'unique@example.com',
      now: NOW,
    });

    await expect(provisionMailboxWithOwner(env.DB, {
      mailboxId: rejectedMailboxId,
      ownerUserId: userId,
      address: 'UNIQUE@example.com',
      now: NOW + 1,
    })).rejects.toThrow();
    await expect(env.DB.prepare('SELECT id FROM mailboxes WHERE id = ?')
      .bind(rejectedMailboxId)
      .first()).resolves.toBeNull();
  });
});
