import { getSystemAdministrator, listAuthorizedMailboxes } from '@cf-webmail/database';
import type { AccessIdentity } from './access-auth.js';
import { apiData } from './api-response.js';

export async function getSession(
  db: D1Database,
  identity: AccessIdentity,
): Promise<Response> {
  const [mailboxes, administrator] = await Promise.all([
    listAuthorizedMailboxes(db, identity),
    getSystemAdministrator(db, identity),
  ]);
  return apiData({
    user: { email: identity.email, isSystemAdmin: administrator !== null },
    mailboxes: mailboxes.map((mailbox) => ({
      id: mailbox.mailboxId,
      address: mailbox.primaryAddress,
      displayName: mailbox.displayName,
      role: mailbox.role,
    })),
  });
}
