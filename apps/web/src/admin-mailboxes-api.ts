import {
  addAdminMailboxAddress,
  getAdminMailboxDetail,
  listAdminMailboxes,
  provisionMailboxWithOwner,
  removeAdminMailboxAddress,
  removeAdminMailboxMembership,
  setAdminMailboxMembership,
  updateAdminMailbox,
  updateAdminMailboxAddress,
} from '@cf-webmail/database';
import { apiData, apiError } from './api-response.js';
import {
  readAdminAddress,
  readAdminMailboxPatch,
  readAdminMembership,
  readCreateAdminMailbox,
} from './admin-input.js';

export async function adminMailboxesCollection(
  request: Request,
  db: D1Database,
  now: number,
): Promise<Response> {
  if (request.method === 'GET') return apiData({ mailboxes: await listAdminMailboxes(db) });
  if (request.method !== 'POST') return apiError('method_not_allowed', 405, 'GET, POST');
  const input = await readCreateAdminMailbox(request);
  const mailboxId = crypto.randomUUID();
  await provisionMailboxWithOwner(db, { mailboxId, ...input, now });
  return apiData({ mailbox: await getAdminMailboxDetail(db, mailboxId) }, 201);
}

export async function adminMailboxResource(
  request: Request,
  db: D1Database,
  mailboxId: string,
  now: number,
): Promise<Response> {
  if (request.method === 'GET') {
    const detail = await getAdminMailboxDetail(db, mailboxId);
    return detail === null ? apiError('mailbox_not_found', 404) : apiData(detail);
  }
  if (request.method !== 'PATCH') return apiError('method_not_allowed', 405, 'GET, PATCH');
  const updated = await updateAdminMailbox(db, {
    mailboxId, ...await readAdminMailboxPatch(request), now,
  });
  return updated
    ? apiData({ mailbox: await getAdminMailboxDetail(db, mailboxId) })
    : apiError('mailbox_not_found', 404);
}

export async function adminMailboxAddresses(
  request: Request,
  db: D1Database,
  mailboxId: string,
  now: number,
): Promise<Response> {
  if (!['POST', 'PATCH', 'DELETE'].includes(request.method)) {
    return apiError('method_not_allowed', 405, 'POST, PATCH, DELETE');
  }
  const input = await readAdminAddress(request);
  if (request.method === 'POST') {
    const found = await addAdminMailboxAddress(db, {
      mailboxId, address: input.address, kind: input.kind ?? 'alias', now,
    });
    return found
      ? apiData({ mailbox: await getAdminMailboxDetail(db, mailboxId) }, 201)
      : apiError('mailbox_not_found', 404);
  }
  if (request.method === 'PATCH') {
    if (input.status === undefined) return apiError('address_status_required', 400);
    const result = await updateAdminMailboxAddress(db, {
      mailboxId, address: input.address, status: input.status, now,
    });
    if (result === 'not-found') return apiError('mailbox_address_not_found', 404);
    if (result === 'active-primary-denied') {
      return apiError('primary_address_cannot_be_disabled', 409);
    }
    return apiData({ mailbox: await getAdminMailboxDetail(db, mailboxId) });
  }
  const result = await removeAdminMailboxAddress(db, { mailboxId, address: input.address });
  if (result === 'not-found') return apiError('mailbox_address_not_found', 404);
  if (result === 'primary-denied') return apiError('primary_address_cannot_be_removed', 409);
  return apiData({ mailbox: await getAdminMailboxDetail(db, mailboxId) });
}

export async function adminMailboxMember(
  request: Request,
  db: D1Database,
  mailboxId: string,
  userId: string,
  now: number,
): Promise<Response> {
  if (request.method === 'PUT') {
    const { role } = await readAdminMembership(request);
    const result = await setAdminMailboxMembership(db, { mailboxId, userId, role, now });
    if (result === 'mailbox-not-found') return apiError('mailbox_not_found', 404);
    if (result === 'user-not-found') return apiError('user_not_found', 404);
    return apiData({ mailbox: await getAdminMailboxDetail(db, mailboxId) });
  }
  if (request.method !== 'DELETE') return apiError('method_not_allowed', 405, 'PUT, DELETE');
  const result = await removeAdminMailboxMembership(db, { mailboxId, userId });
  if (result === 'not-found') return apiError('mailbox_membership_not_found', 404);
  if (result === 'last-owner-denied') return apiError('last_mailbox_owner_cannot_be_removed', 409);
  return apiData({ mailbox: await getAdminMailboxDetail(db, mailboxId) });
}
