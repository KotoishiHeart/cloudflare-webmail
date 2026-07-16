import type { AccessIdentityKey } from './domain.js';
import { normalizeId, normalizeIssuer, normalizeSubject } from './validation.js';
import type { WebAttachment, WebMessageDetail } from './web-message-domain.js';
import {
  toWebAttachment,
  toWebMessageDetail,
  type WebAttachmentRow,
  type WebMessageDetailRow,
} from './web-message-rows.js';

export async function getAuthorizedWebMessage(
  db: D1Database,
  identity: AccessIdentityKey,
  messageIdInput: string,
): Promise<WebMessageDetail | null> {
  const issuer = normalizeIssuer(identity.issuer);
  const subject = normalizeSubject(identity.subject);
  const messageId = normalizeId(messageIdInput, 'messageId');
  const row = await db.prepare(`
    SELECT
      m.id, m.mailbox_id, m.direction, m.status, m.subject, m.sender,
      m.recipients, m.received_at, m.text_preview, m.raw_size,
      m.attachment_count, m.is_read, m.is_starred, m.is_archived, m.is_deleted,
      m.processing_error, m.envelope_from, m.delivered_to, m.rfc_message_id,
      m.in_reply_to, m.references_header, m.cc, m.reply_to, m.date_header,
      m.raw_key, m.body_text_key, m.body_html_key, mm.role
    FROM access_identities AS ai
    JOIN users AS u ON u.id = ai.user_id AND u.status = 'active'
    JOIN mailbox_memberships AS mm ON mm.user_id = u.id
    JOIN mailboxes AS mb
      ON mb.id = mm.mailbox_id AND mb.status = 'active'
    JOIN messages AS m ON m.mailbox_id = mb.id
    WHERE ai.issuer = ? AND ai.subject = ? AND m.id = ?
    LIMIT 1
  `).bind(issuer, subject, messageId).first<WebMessageDetailRow>();
  return row === null ? null : toWebMessageDetail(row);
}

export async function listWebMessageAttachments(
  db: D1Database,
  messageIdInput: string,
): Promise<WebAttachment[]> {
  const messageId = normalizeId(messageIdInput, 'messageId');
  const result = await db.prepare(`
    SELECT ordinal, filename, content_type, disposition, content_id,
      size, sha256, storage_key
    FROM attachments
    WHERE message_id = ?
    ORDER BY ordinal
  `).bind(messageId).all<WebAttachmentRow>();
  return result.results.map(toWebAttachment);
}

export async function getWebMessageAttachment(
  db: D1Database,
  messageIdInput: string,
  ordinalInput: number,
): Promise<WebAttachment | null> {
  const messageId = normalizeId(messageIdInput, 'messageId');
  if (!Number.isSafeInteger(ordinalInput) || ordinalInput < 0 || ordinalInput > 99) {
    throw new Error('attachment ordinal must be between 0 and 99');
  }
  const row = await db.prepare(`
    SELECT ordinal, filename, content_type, disposition, content_id,
      size, sha256, storage_key
    FROM attachments
    WHERE message_id = ? AND ordinal = ?
    LIMIT 1
  `).bind(messageId, ordinalInput).first<WebAttachmentRow>();
  return row === null ? null : toWebAttachment(row);
}
