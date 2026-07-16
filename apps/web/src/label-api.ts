import {
  authorizeMailboxAccess,
  createMailboxLabel,
  deleteMailboxLabel,
  getAuthorizedWebMessage,
  getMailboxLabel,
  listMailboxLabels,
  mailboxRoleGrants,
  replaceMessageLabels,
  updateMailboxLabel,
} from '@cf-webmail/database';
import type { AccessIdentity } from './access-auth.js';
import { requestIsSameOrigin } from './api-input.js';
import { apiData, apiError } from './api-response.js';
import { readLabelPatch, readMessageLabelIds } from './label-input.js';

export async function getLabels(
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
): Promise<Response> {
  const access = await authorizeMailboxAccess(db, identity, mailboxId, 'read');
  if (!access.allowed) return apiError('mailbox_not_found', 404);
  return apiData({ labels: await listMailboxLabels(db, access.mailboxId) });
}

export async function createLabel(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
  now: number,
): Promise<Response> {
  const access = await labelMutationAccess(request, db, identity, mailboxId);
  if (access instanceof Response) return access;
  const input = await readLabelPatch(request, true);
  const label = await createMailboxLabel(db, {
    id: crypto.randomUUID(),
    mailboxId: access.mailboxId,
    userId: access.userId,
    name: input.name ?? '',
    color: input.color ?? '#64748b',
    description: input.description ?? '',
    now,
  });
  return apiData({ label }, 201);
}

export async function patchLabel(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
  labelId: string,
  now: number,
): Promise<Response> {
  const access = await labelMutationAccess(request, db, identity, mailboxId);
  if (access instanceof Response) return access;
  const current = await getMailboxLabel(db, access.mailboxId, labelId);
  if (current === null) return apiError('label_not_found', 404);
  const input = await readLabelPatch(request, false);
  await updateMailboxLabel(db, {
    id: current.id,
    mailboxId: current.mailboxId,
    name: input.name ?? current.name,
    color: input.color ?? current.color,
    description: input.description ?? current.description,
    now,
  });
  const updated = await getMailboxLabel(db, access.mailboxId, labelId);
  if (updated === null) throw new Error('updated label became unavailable');
  return apiData({ label: updated });
}

export async function removeLabel(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
  labelId: string,
): Promise<Response> {
  const access = await labelMutationAccess(request, db, identity, mailboxId);
  if (access instanceof Response) return access;
  const deleted = await deleteMailboxLabel(db, access.mailboxId, labelId);
  return deleted ? apiData({ deleted: true }) : apiError('label_not_found', 404);
}

export async function putMessageLabels(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  messageId: string,
  now: number,
): Promise<Response> {
  if (!requestIsSameOrigin(request)) return apiError('cross_origin_request_denied', 403);
  const message = await getAuthorizedWebMessage(db, identity, messageId);
  if (message === null) return apiError('message_not_found', 404);
  if (!mailboxRoleGrants(message.role, 'operate')) return apiError('insufficient_role', 403);
  const access = await authorizeMailboxAccess(db, identity, message.mailboxId, 'operate');
  if (!access.allowed) return apiError('message_not_found', 404);
  const labels = await replaceMessageLabels(db, {
    mailboxId: message.mailboxId,
    messageId: message.id,
    userId: access.userId,
    labelIds: await readMessageLabelIds(request),
    now,
  });
  return apiData({ labels });
}

async function labelMutationAccess(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
) {
  if (!requestIsSameOrigin(request)) return apiError('cross_origin_request_denied', 403);
  const access = await authorizeMailboxAccess(db, identity, mailboxId, 'read');
  if (!access.allowed) return apiError('mailbox_not_found', 404);
  if (!mailboxRoleGrants(access.role, 'manage')) return apiError('insufficient_role', 403);
  return access;
}
