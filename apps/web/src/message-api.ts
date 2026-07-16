import {
  authorizeMailboxAccess,
  getAuthorizedWebMessage,
  isWebMailboxFolder,
  listWebMessageAttachments,
  listWebMessages,
  mailboxRoleGrants,
  updateWebMessageFlags,
  type WebMessageDetail,
} from '@cf-webmail/database';
import type { AccessIdentity } from './access-auth.js';
import { readFlagPatch, requestIsSameOrigin } from './api-input.js';
import { messageListQueryFromUrl } from './message-list-input.js';
import { apiData, apiError } from './api-response.js';

export async function getMessageList(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
  now: number,
): Promise<Response> {
  const access = await authorizeMailboxAccess(db, identity, mailboxId, 'read');
  if (!access.allowed) return apiError('mailbox_not_found', 404);
  const url = new URL(request.url);
  const folderInput = url.searchParams.get('folder') ?? 'inbox';
  if (!isWebMailboxFolder(folderInput)) return apiError('invalid_folder', 400);
  const page = await listWebMessages(
    db,
    mailboxId,
    messageListQueryFromUrl(url, folderInput, now),
  );
  return apiData({ mailboxId, folder: folderInput, ...page });
}

export async function getMessageDetail(
  db: D1Database,
  identity: AccessIdentity,
  messageId: string,
): Promise<Response> {
  const message = await getAuthorizedWebMessage(db, identity, messageId);
  if (message === null) return apiError('message_not_found', 404);
  const attachments = await listWebMessageAttachments(db, messageId);
  return apiData({
    message: publicMessage(message),
    attachments: attachments.map((attachment) => ({
      ordinal: attachment.ordinal,
      filename: attachment.filename,
      contentType: attachment.contentType,
      disposition: attachment.disposition,
      contentId: attachment.contentId,
      size: attachment.size,
      sha256: attachment.sha256,
      downloadUrl: `/api/messages/${messageId}/attachments/${attachment.ordinal}`,
    })),
  });
}

export async function patchMessage(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  messageId: string,
  now: number,
): Promise<Response> {
  if (!requestIsSameOrigin(request)) return apiError('cross_origin_request_denied', 403);
  const message = await getAuthorizedWebMessage(db, identity, messageId);
  if (message === null) return apiError('message_not_found', 404);
  if (!mailboxRoleGrants(message.role, 'operate')) {
    return apiError('insufficient_role', 403);
  }
  const patch = await readFlagPatch(request);
  await updateWebMessageFlags(db, message.id, message.mailboxId, patch, now);
  const updated = await getAuthorizedWebMessage(db, identity, messageId);
  if (updated === null) throw new Error('updated message became unavailable');
  return apiData({ message: publicMessage(updated) });
}

function publicMessage(message: WebMessageDetail) {
  return {
    id: message.id,
    mailboxId: message.mailboxId,
    role: message.role,
    direction: message.direction,
    status: message.status,
    processingError: message.processingError,
    subject: message.subject,
    sender: message.sender,
    recipients: message.recipients,
    cc: message.cc,
    replyTo: message.replyTo,
    envelopeFrom: message.envelopeFrom,
    deliveredTo: message.deliveredTo,
    rfcMessageId: message.rfcMessageId,
    inReplyTo: message.inReplyTo,
    referencesHeader: message.referencesHeader,
    dateHeader: message.dateHeader,
    receivedAt: message.receivedAt,
    textPreview: message.textPreview,
    rawSize: message.rawSize,
    attachmentCount: message.attachmentCount,
    isRead: message.isRead,
    isStarred: message.isStarred,
    isArchived: message.isArchived,
    isDeleted: message.isDeleted,
    bodyUrl: message.bodyTextKey !== null || message.bodyHtmlKey !== null
      ? `/api/messages/${message.id}/body`
      : null,
    rawUrl: `/api/messages/${message.id}/raw`,
  };
}
