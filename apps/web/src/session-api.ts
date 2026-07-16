import { listAuthorizedMailboxes } from '@cf-webmail/database';
import type { AccessIdentity } from './access-auth.js';
import { apiData } from './api-response.js';

export async function getSession(
  db: D1Database,
  identity: AccessIdentity,
): Promise<Response> {
  const mailboxes = await listAuthorizedMailboxes(db, identity);
  return apiData({
    user: { email: identity.email },
    mailboxes: mailboxes.map((mailbox) => ({
      id: mailbox.mailboxId,
      address: mailbox.primaryAddress,
      displayName: mailbox.displayName,
      role: mailbox.role,
    })),
  });
}
