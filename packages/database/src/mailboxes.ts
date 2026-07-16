import {
  isMailboxAddressKind,
  isMailboxRole,
  mailboxRoleGrants,
  type AccessIdentityKey,
  type AuthorizedMailbox,
  type MailboxAccessDecision,
  type MailboxCapability,
  type MailboxRoute,
} from './domain.js';
import {
  normalizeEmailAddress,
  normalizeId,
  normalizeIssuer,
  normalizeSubject,
} from './validation.js';

type RouteRow = {
  mailbox_id: string;
  address: string;
  address_kind: string;
  display_name: string;
};

type AccessRow = {
  user_id: string;
  user_status: string;
  mailbox_id: string | null;
  mailbox_status: string | null;
  role: string | null;
};

type AuthorizedMailboxRow = RouteRow & {
  user_id: string;
  role: string;
};

export async function resolveActiveMailboxAddress(
  db: D1Database,
  addressInput: string,
): Promise<MailboxRoute | null> {
  const address = normalizeEmailAddress(addressInput, 'address');
  const row = await db.prepare(`
    SELECT
      m.id AS mailbox_id,
      ma.address,
      ma.kind AS address_kind,
      m.display_name
    FROM mailbox_addresses AS ma
    JOIN mailboxes AS m ON m.id = ma.mailbox_id
    WHERE ma.address = ? COLLATE NOCASE
      AND ma.status = 'active'
      AND m.status = 'active'
    LIMIT 1
  `).bind(address).first<RouteRow>();

  return row === null ? null : toMailboxRoute(row);
}

export async function authorizeMailboxAccess(
  db: D1Database,
  identity: AccessIdentityKey,
  mailboxIdInput: string,
  capability: MailboxCapability,
): Promise<MailboxAccessDecision> {
  const issuer = normalizeIssuer(identity.issuer);
  const subject = normalizeSubject(identity.subject);
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const row = await db.prepare(`
    SELECT
      u.id AS user_id,
      u.status AS user_status,
      m.id AS mailbox_id,
      m.status AS mailbox_status,
      mm.role
    FROM access_identities AS ai
    JOIN users AS u ON u.id = ai.user_id
    LEFT JOIN mailboxes AS m ON m.id = ?
    LEFT JOIN mailbox_memberships AS mm
      ON mm.mailbox_id = m.id AND mm.user_id = u.id
    WHERE ai.issuer = ? AND ai.subject = ?
    LIMIT 1
  `).bind(mailboxId, issuer, subject).first<AccessRow>();

  if (row === null) return { allowed: false, reason: 'identity-not-linked' };
  if (row.user_status !== 'active') return { allowed: false, reason: 'user-disabled' };
  if (row.mailbox_id === null) return { allowed: false, reason: 'mailbox-not-found' };
  if (row.mailbox_status !== 'active') return { allowed: false, reason: 'mailbox-disabled' };
  if (!isMailboxRole(row.role)) return { allowed: false, reason: 'not-a-member' };
  if (!mailboxRoleGrants(row.role, capability)) {
    return { allowed: false, reason: 'insufficient-role' };
  }

  return {
    allowed: true,
    userId: row.user_id,
    mailboxId: row.mailbox_id,
    role: row.role,
  };
}

export async function listAuthorizedMailboxes(
  db: D1Database,
  identity: AccessIdentityKey,
): Promise<AuthorizedMailbox[]> {
  const issuer = normalizeIssuer(identity.issuer);
  const subject = normalizeSubject(identity.subject);
  const result = await db.prepare(`
    SELECT
      u.id AS user_id,
      m.id AS mailbox_id,
      ma.address,
      ma.kind AS address_kind,
      m.display_name,
      mm.role
    FROM access_identities AS ai
    JOIN users AS u ON u.id = ai.user_id AND u.status = 'active'
    JOIN mailbox_memberships AS mm ON mm.user_id = u.id
    JOIN mailboxes AS m ON m.id = mm.mailbox_id AND m.status = 'active'
    JOIN mailbox_addresses AS ma
      ON ma.mailbox_id = m.id
      AND ma.kind = 'primary'
      AND ma.status = 'active'
    WHERE ai.issuer = ? AND ai.subject = ?
    ORDER BY ma.address COLLATE NOCASE
  `).bind(issuer, subject).all<AuthorizedMailboxRow>();

  return result.results.flatMap((row) => {
    if (!isMailboxRole(row.role)) return [];
    return [{ ...toMailboxRoute(row), userId: row.user_id, role: row.role }];
  });
}

function toMailboxRoute(row: RouteRow): MailboxRoute {
  if (!isMailboxAddressKind(row.address_kind)) {
    throw new Error('D1 returned an invalid mailbox address kind');
  }
  return {
    mailboxId: row.mailbox_id,
    address: row.address,
    addressKind: row.address_kind,
    displayName: row.display_name,
  };
}
