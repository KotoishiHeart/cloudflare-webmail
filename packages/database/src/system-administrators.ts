import type { AccessIdentityKey } from './domain.js';
import { normalizeIssuer, normalizeSubject } from './validation.js';

export type SystemAdministrator = {
  userId: string;
  email: string;
};

export async function getSystemAdministrator(
  db: D1Database,
  identity: AccessIdentityKey,
): Promise<SystemAdministrator | null> {
  const row = await db.prepare(`
    SELECT u.id AS user_id, u.email
    FROM access_identities AS ai
    JOIN users AS u ON u.id = ai.user_id AND u.status = 'active'
    JOIN system_administrators AS admin ON admin.user_id = u.id
    WHERE ai.issuer = ? AND ai.subject = ?
    LIMIT 1
  `).bind(
    normalizeIssuer(identity.issuer),
    normalizeSubject(identity.subject),
  ).first<{ user_id: string; email: string }>();
  return row === null ? null : { userId: row.user_id, email: row.email };
}
