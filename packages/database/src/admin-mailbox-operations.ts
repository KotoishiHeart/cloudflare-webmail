import { isMailboxRole, type MailboxRole } from './domain.js';
import {
  DatabaseInputError,
  normalizeDisplayName,
  normalizeEmailAddress,
  normalizeId,
  requireTimestamp,
} from './validation.js';

export async function updateAdminMailbox(
  db: D1Database,
  input: {
    mailboxId: string;
    displayName?: string;
    status?: 'active' | 'disabled';
    now: number;
  },
): Promise<boolean> {
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  const current = await db.prepare(
    'SELECT display_name, status FROM mailboxes WHERE id = ?',
  ).bind(mailboxId).first<{ display_name: string; status: 'active' | 'disabled' }>();
  if (current === null) return false;
  const displayName = input.displayName === undefined
    ? current.display_name
    : normalizeDisplayName(input.displayName, current.display_name);
  await db.prepare(`
    UPDATE mailboxes SET display_name = ?, status = ?, updated_at = ? WHERE id = ?
  `).bind(
    displayName, input.status ?? current.status, requireTimestamp(input.now), mailboxId,
  ).run();
  return true;
}

export async function addAdminMailboxAddress(
  db: D1Database,
  input: {
    mailboxId: string;
    address: string;
    kind: 'primary' | 'alias';
    now: number;
  },
): Promise<boolean> {
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  const exists = await db.prepare('SELECT 1 AS found FROM mailboxes WHERE id = ?')
    .bind(mailboxId).first();
  if (exists === null) return false;
  const now = requireTimestamp(input.now);
  await db.prepare(`
    INSERT INTO mailbox_addresses (address, mailbox_id, kind, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).bind(
    normalizeEmailAddress(input.address, 'address'), mailboxId, input.kind, now, now,
  ).run();
  return true;
}

export async function updateAdminMailboxAddress(
  db: D1Database,
  input: {
    mailboxId: string;
    address: string;
    status: 'active' | 'disabled';
    now: number;
  },
): Promise<'updated' | 'not-found' | 'active-primary-denied'> {
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  const address = normalizeEmailAddress(input.address, 'address');
  const current = await db.prepare(`
    SELECT kind, status FROM mailbox_addresses WHERE mailbox_id = ? AND address = ?
  `).bind(mailboxId, address).first<{ kind: string; status: string }>();
  if (current === null) return 'not-found';
  if (current.kind === 'primary' && input.status === 'disabled') return 'active-primary-denied';
  await db.prepare(`
    UPDATE mailbox_addresses SET status = ?, updated_at = ?
    WHERE mailbox_id = ? AND address = ?
  `).bind(input.status, requireTimestamp(input.now), mailboxId, address).run();
  return 'updated';
}

export async function removeAdminMailboxAddress(
  db: D1Database,
  input: { mailboxId: string; address: string },
): Promise<'deleted' | 'not-found' | 'primary-denied'> {
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  const address = normalizeEmailAddress(input.address, 'address');
  const current = await db.prepare(`
    SELECT kind FROM mailbox_addresses WHERE mailbox_id = ? AND address = ?
  `).bind(mailboxId, address).first<{ kind: string }>();
  if (current === null) return 'not-found';
  if (current.kind === 'primary') return 'primary-denied';
  await db.prepare(
    'DELETE FROM mailbox_addresses WHERE mailbox_id = ? AND address = ?',
  ).bind(mailboxId, address).run();
  return 'deleted';
}

export async function setAdminMailboxMembership(
  db: D1Database,
  input: { mailboxId: string; userId: string; role: MailboxRole; now: number },
): Promise<'updated' | 'mailbox-not-found' | 'user-not-found'> {
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  const userId = normalizeId(input.userId, 'userId');
  if (!isMailboxRole(input.role)) {
    throw new DatabaseInputError('role', 'must be viewer, operator, or owner');
  }
  const refs = await db.prepare(`
    SELECT EXISTS(SELECT 1 FROM mailboxes WHERE id = ?) AS mailbox_found,
      EXISTS(SELECT 1 FROM users WHERE id = ?) AS user_found
  `).bind(mailboxId, userId).first<{ mailbox_found: number; user_found: number }>();
  if (refs?.mailbox_found !== 1) return 'mailbox-not-found';
  if (refs.user_found !== 1) return 'user-not-found';
  const now = requireTimestamp(input.now);
  await db.prepare(`
    INSERT INTO mailbox_memberships (mailbox_id, user_id, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(mailbox_id, user_id) DO UPDATE SET
      role = excluded.role, updated_at = excluded.updated_at
  `).bind(mailboxId, userId, input.role, now, now).run();
  return 'updated';
}

export async function removeAdminMailboxMembership(
  db: D1Database,
  input: { mailboxId: string; userId: string },
): Promise<'deleted' | 'not-found' | 'last-owner-denied'> {
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  const userId = normalizeId(input.userId, 'userId');
  const current = await db.prepare(`
    SELECT role, (SELECT COUNT(*) FROM mailbox_memberships
      WHERE mailbox_id = ? AND role = 'owner') AS owner_count
    FROM mailbox_memberships WHERE mailbox_id = ? AND user_id = ?
  `).bind(mailboxId, mailboxId, userId).first<{ role: string; owner_count: number }>();
  if (current === null) return 'not-found';
  if (current.role === 'owner' && current.owner_count <= 1) return 'last-owner-denied';
  await db.prepare(
    'DELETE FROM mailbox_memberships WHERE mailbox_id = ? AND user_id = ?',
  ).bind(mailboxId, userId).run();
  return 'deleted';
}
