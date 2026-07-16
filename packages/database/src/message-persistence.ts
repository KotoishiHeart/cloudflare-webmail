import type {
  InboundAttachmentRecord,
  InboundMessageRecord,
  PersistInboundResult,
} from './message-domain.js';
import {
  findInboundMessageByContent,
  findInboundMessageById,
  requireSha256,
} from './message-queries.js';
import { normalizeEmailAddress, normalizeId, requireTimestamp } from './validation.js';

export async function persistInboundMessage(
  db: D1Database,
  record: InboundMessageRecord,
): Promise<PersistInboundResult> {
  validateRecord(record);
  const statements: D1PreparedStatement[] = [prepareMessageInsert(db, record)];
  for (const attachment of record.attachments) {
    statements.push(prepareAttachmentInsert(db, record, attachment));
  }

  const results = await db.batch(statements);
  const created = Number(results[0]?.meta.changes ?? 0) > 0;
  const sameId = await findInboundMessageById(db, record.id);
  if (sameId !== null) {
    if (sameId.mailboxId !== record.mailboxId || sameId.rawSha256 !== record.rawSha256) {
      throw new Error('message ID collision detected');
    }
    return { message: sameId, created, duplicateBy: created ? null : 'id' };
  }

  const sameContent = await findInboundMessageByContent(db, record.mailboxId, record.rawSha256);
  if (sameContent !== null) {
    return { message: sameContent, created: false, duplicateBy: 'content' };
  }
  throw new Error('message batch completed without a persisted record');
}

function prepareMessageInsert(db: D1Database, record: InboundMessageRecord): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO messages (
      id, mailbox_id, direction, status, processing_error,
      envelope_from, delivered_to, rfc_message_id, in_reply_to, references_header,
      subject, sender, recipients, cc, reply_to, date_header, received_at,
      text_preview, raw_key, raw_sha256, raw_etag, raw_size,
      body_text_key, body_html_key, attachment_count, created_at, updated_at
    ) VALUES (
      ?, ?, 'inbound', ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
    ON CONFLICT DO NOTHING
  `).bind(
    record.id, record.mailboxId, record.status, record.processingError,
    record.envelopeFrom, record.deliveredTo, record.rfcMessageId,
    record.inReplyTo, record.referencesHeader, record.subject, record.sender,
    record.recipients, record.cc, record.replyTo, record.dateHeader,
    record.receivedAt, record.textPreview, record.rawKey, record.rawSha256,
    record.rawEtag, record.rawSize, record.bodyTextKey, record.bodyHtmlKey,
    record.attachments.length, record.createdAt, record.createdAt,
  );
}

function prepareAttachmentInsert(
  db: D1Database,
  record: InboundMessageRecord,
  attachment: InboundAttachmentRecord,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO attachments (
      message_id, ordinal, filename, content_type, disposition,
      content_id, size, sha256, storage_key, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM messages WHERE id = ? AND raw_sha256 = ?
    )
    ON CONFLICT DO NOTHING
  `).bind(
    record.id, attachment.ordinal, attachment.filename, attachment.contentType,
    attachment.disposition, attachment.contentId, attachment.size, attachment.sha256,
    attachment.storageKey, attachment.createdAt, record.id, record.rawSha256,
  );
}

function validateRecord(record: InboundMessageRecord): void {
  normalizeId(record.id, 'messageId');
  normalizeId(record.mailboxId, 'mailboxId');
  normalizeEmailAddress(record.deliveredTo, 'deliveredTo');
  requireSha256(record.rawSha256);
  requireTimestamp(record.receivedAt, 'receivedAt');
  requireTimestamp(record.createdAt, 'createdAt');
  if (record.attachments.length > 100) throw new Error('attachment count exceeds 100');
  for (const [ordinal, attachment] of record.attachments.entries()) {
    if (attachment.ordinal !== ordinal) throw new Error('attachment ordinals must be contiguous');
    requireSha256(attachment.sha256);
  }
}
