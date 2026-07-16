import {
  getAuthorizedWebMessage,
  getWebMessageAttachment,
} from '@cf-webmail/database';
import type { AccessIdentity } from './access-auth.js';
import { apiError, objectHeaders } from './api-response.js';

export async function getMessageBody(
  bucket: R2Bucket,
  db: D1Database,
  identity: AccessIdentity,
  messageId: string,
): Promise<Response> {
  const message = await getAuthorizedWebMessage(db, identity, messageId);
  if (message === null) return apiError('message_not_found', 404);
  const key = message.bodyTextKey ?? message.bodyHtmlKey;
  if (key === null) return apiError('message_body_not_available', 404);
  const object = await bucket.get(key);
  if (object === null) return apiError('message_body_missing', 404);
  const headers = objectHeaders('text/plain; charset=utf-8');
  headers.set('x-webmail-body-source', message.bodyTextKey === null ? 'html-source' : 'text');
  return new Response(object.body, { headers });
}

export async function downloadRawMessage(
  bucket: R2Bucket,
  db: D1Database,
  identity: AccessIdentity,
  messageId: string,
): Promise<Response> {
  const message = await getAuthorizedWebMessage(db, identity, messageId);
  if (message === null) return apiError('message_not_found', 404);
  const object = await bucket.get(message.rawKey);
  if (object === null) return apiError('raw_message_missing', 404);
  const headers = objectHeaders('message/rfc822');
  headers.set('content-disposition', attachmentDisposition(`${message.id}.eml`));
  return new Response(object.body, { headers });
}

export async function downloadMessageAttachment(
  bucket: R2Bucket,
  db: D1Database,
  identity: AccessIdentity,
  messageId: string,
  ordinal: number,
): Promise<Response> {
  const message = await getAuthorizedWebMessage(db, identity, messageId);
  if (message === null) return apiError('message_not_found', 404);
  const attachment = await getWebMessageAttachment(db, messageId, ordinal);
  if (attachment === null) return apiError('attachment_not_found', 404);
  const object = await bucket.get(attachment.storageKey);
  if (object === null) return apiError('attachment_missing', 404);
  const headers = objectHeaders('application/octet-stream');
  headers.set('content-disposition', attachmentDisposition(attachment.filename));
  headers.set('content-length', String(object.size));
  return new Response(object.body, { headers });
}

function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/gu, '_')
    .replace(/["\\]/gu, '_')
    .slice(0, 120) || 'download';
  const encoded = encodeURIComponent(filename).replace(/['()*]/gu, (character) => (
    `%${character.codePointAt(0)?.toString(16).toUpperCase()}`
  ));
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
