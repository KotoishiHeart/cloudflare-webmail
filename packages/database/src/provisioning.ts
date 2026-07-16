import { isMailboxRole, type MailboxRole } from './domain.js';
import {
  DatabaseInputError,
  normalizeDisplayName,
  normalizeEmailAddress,
  normalizeId,
  normalizeIssuer,
  normalizeSubject,
  requireTimestamp,
} from './validation.js';

export type ProvisionUserInput = {
  userId: string;
  email: string;
  displayName?: string;
  identity: {
    issuer: string;
    subject: string;
    email?: string;
  };
  now: number;
};

export type ProvisionMailboxInput = {
  mailboxId: string;
  ownerUserId: string;
  address: string;
  displayName?: string;
  now: number;
};

export type SetMailboxMembershipInput = {
  mailboxId: string;
  userId: string;
  role: MailboxRole;
  now: number;
};

export type AddMailboxAliasInput = {
  mailboxId: string;
  address: string;
  now: number;
};

export async function provisionUserWithIdentity(
  db: D1Database,
  input: ProvisionUserInput,
): Promise<void> {
  const userId = normalizeId(input.userId, 'userId');
  const email = normalizeEmailAddress(input.email);
  const identityEmail = normalizeEmailAddress(input.identity.email ?? input.email, 'identity.email');
  const displayName = input.displayName === undefined
    ? null
    : normalizeDisplayName(input.displayName, email);
  const issuer = normalizeIssuer(input.identity.issuer);
  const subject = normalizeSubject(input.identity.subject);
  const now = requireTimestamp(input.now);

  await db.batch([
    db.prepare(`
      INSERT INTO users (id, email, display_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).bind(userId, email, displayName, now, now),
    db.prepare(`
      INSERT INTO access_identities (
        issuer, subject, user_id, email, created_at, updated_at, last_seen_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(issuer, subject, userId, identityEmail, now, now, now),
  ]);
}

export async function provisionMailboxWithOwner(
  db: D1Database,
  input: ProvisionMailboxInput,
): Promise<void> {
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  const ownerUserId = normalizeId(input.ownerUserId, 'ownerUserId');
  const address = normalizeEmailAddress(input.address, 'address');
  const displayName = normalizeDisplayName(input.displayName, address);
  const now = requireTimestamp(input.now);

  await db.batch([
    db.prepare(`
      INSERT INTO mailboxes (id, display_name, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)
    `).bind(mailboxId, displayName, now, now),
    db.prepare(`
      INSERT INTO mailbox_addresses (
        address, mailbox_id, kind, status, created_at, updated_at
      )
      VALUES (?, ?, 'primary', 'active', ?, ?)
    `).bind(address, mailboxId, now, now),
    db.prepare(`
      INSERT INTO mailbox_memberships (
        mailbox_id, user_id, role, created_at, updated_at
      )
      VALUES (?, ?, 'owner', ?, ?)
    `).bind(mailboxId, ownerUserId, now, now),
  ]);
}

export async function setMailboxMembership(
  db: D1Database,
  input: SetMailboxMembershipInput,
): Promise<void> {
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  const userId = normalizeId(input.userId, 'userId');
  if (!isMailboxRole(input.role)) {
    throw new DatabaseInputError('role', 'must be viewer, operator, or owner');
  }
  const now = requireTimestamp(input.now);

  await db.prepare(`
    INSERT INTO mailbox_memberships (mailbox_id, user_id, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (mailbox_id, user_id) DO UPDATE SET
      role = excluded.role,
      updated_at = excluded.updated_at
  `).bind(mailboxId, userId, input.role, now, now).run();
}

export async function addMailboxAlias(
  db: D1Database,
  input: AddMailboxAliasInput,
): Promise<void> {
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  const address = normalizeEmailAddress(input.address, 'address');
  const now = requireTimestamp(input.now);

  await db.prepare(`
    INSERT INTO mailbox_addresses (
      address, mailbox_id, kind, status, created_at, updated_at
    )
    VALUES (?, ?, 'alias', 'active', ?, ?)
  `).bind(address, mailboxId, now, now).run();
}
