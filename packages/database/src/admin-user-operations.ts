import {
  DatabaseInputError,
  normalizeDisplayName,
  normalizeEmailAddress,
  normalizeId,
  normalizeIssuer,
  normalizeSubject,
  requireTimestamp,
} from './validation.js';

export type AdminUserPatch = {
  email?: string;
  displayName?: string | null;
  status?: 'active' | 'disabled';
};

export async function updateAdminUser(
  db: D1Database,
  input: { userId: string; actorUserId: string; patch: AdminUserPatch; now: number },
): Promise<'updated' | 'not-found' | 'self-disable-denied' | 'administrator-disable-denied'> {
  const userId = normalizeId(input.userId, 'userId');
  const actorUserId = normalizeId(input.actorUserId, 'actorUserId');
  const current = await db.prepare(`
    SELECT u.email, u.display_name, u.status,
      CASE WHEN sa.user_id IS NULL THEN 0 ELSE 1 END AS is_admin
    FROM users u LEFT JOIN system_administrators sa ON sa.user_id = u.id WHERE u.id = ?
  `).bind(userId).first<{
    email: string; display_name: string | null; status: 'active' | 'disabled'; is_admin: number;
  }>();
  if (current === null) return 'not-found';
  const status = input.patch.status ?? current.status;
  if (status === 'disabled' && userId === actorUserId) return 'self-disable-denied';
  if (status === 'disabled' && current.is_admin === 1) return 'administrator-disable-denied';
  const email = input.patch.email === undefined
    ? current.email
    : normalizeEmailAddress(input.patch.email);
  const displayName = input.patch.displayName === undefined
    ? current.display_name
    : input.patch.displayName === null ? null : normalizeDisplayName(input.patch.displayName, email);
  await db.prepare(`
    UPDATE users SET email = ?, display_name = ?, status = ?, updated_at = ? WHERE id = ?
  `).bind(email, displayName, status, requireTimestamp(input.now), userId).run();
  return 'updated';
}

export async function addAdminAccessIdentity(
  db: D1Database,
  input: { userId: string; issuer: string; subject: string; email: string; now: number },
): Promise<boolean> {
  const userId = normalizeId(input.userId, 'userId');
  const exists = await db.prepare('SELECT 1 AS found FROM users WHERE id = ?').bind(userId).first();
  if (exists === null) return false;
  const now = requireTimestamp(input.now);
  await db.prepare(`
    INSERT INTO access_identities (
      issuer, subject, user_id, email, created_at, updated_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    normalizeIssuer(input.issuer), normalizeSubject(input.subject), userId,
    normalizeEmailAddress(input.email, 'identity.email'), now, now, now,
  ).run();
  return true;
}

export async function removeAdminAccessIdentity(
  db: D1Database,
  input: { userId: string; issuer: string; subject: string },
): Promise<'deleted' | 'not-found' | 'last-identity-denied'> {
  const userId = normalizeId(input.userId, 'userId');
  const issuer = normalizeIssuer(input.issuer);
  const subject = normalizeSubject(input.subject);
  const row = await db.prepare(`
    SELECT (SELECT COUNT(*) FROM access_identities WHERE user_id = ?) AS identity_count,
      (SELECT status FROM users WHERE id = ?) AS user_status,
      EXISTS(SELECT 1 FROM access_identities
        WHERE user_id = ? AND issuer = ? AND subject = ?) AS found
  `).bind(userId, userId, userId, issuer, subject).first<{
    identity_count: number; user_status: string | null; found: number;
  }>();
  if (row === null || row.found !== 1) return 'not-found';
  if (row.user_status === 'active' && row.identity_count <= 1) return 'last-identity-denied';
  await db.prepare(`
    DELETE FROM access_identities WHERE user_id = ? AND issuer = ? AND subject = ?
  `).bind(userId, issuer, subject).run();
  return 'deleted';
}

export async function setAdminGrant(
  db: D1Database,
  input: { userId: string; actorUserId: string; enabled: boolean; now: number },
): Promise<'updated' | 'not-found' | 'inactive-user' | 'self-revoke-denied' | 'last-admin-denied'> {
  const userId = normalizeId(input.userId, 'userId');
  const actor = normalizeId(input.actorUserId, 'actorUserId');
  const user = await db.prepare('SELECT status FROM users WHERE id = ?').bind(userId)
    .first<{ status: string }>();
  if (user === null) return 'not-found';
  if (input.enabled) {
    if (user.status !== 'active') return 'inactive-user';
    await db.prepare(`
      INSERT INTO system_administrators (user_id, granted_by_user_id, source, granted_at)
      VALUES (?, ?, 'admin', ?)
      ON CONFLICT(user_id) DO UPDATE SET
        granted_by_user_id = excluded.granted_by_user_id,
        source = excluded.source,
        granted_at = excluded.granted_at
    `).bind(userId, actor, requireTimestamp(input.now)).run();
    return 'updated';
  }
  if (userId === actor) return 'self-revoke-denied';
  const count = await db.prepare(`
    SELECT COUNT(*) AS count FROM system_administrators sa
    JOIN users u ON u.id = sa.user_id WHERE u.status = 'active'
  `).first<{ count: number }>();
  if ((count?.count ?? 0) <= 1) return 'last-admin-denied';
  await db.prepare('DELETE FROM system_administrators WHERE user_id = ?').bind(userId).run();
  return 'updated';
}

export function assertRecordStatus(value: unknown): 'active' | 'disabled' {
  if (value !== 'active' && value !== 'disabled') {
    throw new DatabaseInputError('status', 'must be active or disabled');
  }
  return value;
}
