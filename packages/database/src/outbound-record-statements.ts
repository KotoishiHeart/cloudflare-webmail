import type {
  OutboundMessageRecord,
  OutboundRecipient,
} from './outbound-domain.js';
import {
  DatabaseInputError,
  normalizeEmailAddress,
  normalizeId,
  requireTimestamp,
} from './validation.js';
import { requireSha256 } from './message-queries.js';
import { validateOutboundAttachments } from './outbound-attachments.js';

export function prepareOutboundMessageInsert(
  db: D1Database,
  record: OutboundMessageRecord,
  to: string[],
  cc: string[],
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO messages (
      id, mailbox_id, direction, status, processing_error,
      envelope_from, delivered_to, rfc_message_id, in_reply_to, references_header,
      subject, sender, recipients, cc, reply_to, date_header, received_at,
      text_preview, raw_key, raw_sha256, raw_etag, raw_size,
      body_text_key, body_html_key, attachment_count,
      is_read, created_at, updated_at
    ) VALUES (
      ?, ?, 'outbound', 'queued', '',
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, '', ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      1, ?, ?
    )
  `).bind(
    record.id,
    record.mailboxId,
    record.senderAddress,
    record.senderAddress,
    record.archiveMessageId,
    record.inReplyTo,
    record.referencesHeader,
    record.subject,
    record.sender,
    to.join(', '),
    cc.join(', '),
    new Date(record.createdAt).toUTCString(),
    record.createdAt,
    record.textPreview,
    record.rawKey,
    record.rawSha256,
    record.rawEtag,
    record.rawSize,
    record.bodyTextKey,
    record.bodyHtmlKey,
    record.attachments.length,
    record.createdAt,
    record.createdAt,
  );
}

export function prepareCompositionInsert(
  db: D1Database,
  record: OutboundMessageRecord,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO outbound_compositions (
      message_id, compose_mode, source_message_id, created_at
    ) VALUES (?, ?, ?, ?)
  `).bind(record.id, record.composeMode, record.sourceMessageId, record.createdAt);
}

export function prepareRecipientInsert(
  db: D1Database,
  messageId: string,
  recipient: OutboundRecipient,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO outbound_recipients (message_id, kind, ordinal, address)
    VALUES (?, ?, ?, ?)
  `).bind(messageId, recipient.kind, recipient.ordinal, recipient.address);
}

export function prepareDeliveryInsert(
  db: D1Database,
  record: OutboundMessageRecord,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO outbound_deliveries (
      message_id, mailbox_id, idempotency_key, requested_by_user_id,
      sender_address, sender_name, status,
      enqueued_at, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
  `).bind(
    record.id,
    record.mailboxId,
    record.idempotencyKey,
    record.requestedByUserId,
    record.senderAddress,
    senderName(record.sender, record.senderAddress),
    record.createdAt,
    record.createdAt,
    record.createdAt,
    record.createdAt,
  );
}

export function validateOutboundRecord(record: OutboundMessageRecord): void {
  normalizeId(record.id, 'messageId');
  normalizeId(record.mailboxId, 'mailboxId');
  normalizeId(record.requestedByUserId, 'requestedByUserId');
  normalizeId(record.idempotencyKey, 'Idempotency-Key');
  normalizeEmailAddress(record.senderAddress, 'senderAddress');
  requireSha256(record.rawSha256);
  requireTimestamp(record.createdAt, 'createdAt');
  if (!['new', 'reply', 'forward'].includes(record.composeMode)) {
    throw new DatabaseInputError('composeMode', 'must be new, reply, or forward');
  }
  if ((record.composeMode === 'new') !== (record.sourceMessageId === null)) {
    throw new DatabaseInputError(
      'sourceMessageId',
      'must be null only when composeMode is new',
    );
  }
  if (record.sourceMessageId !== null) normalizeId(record.sourceMessageId, 'sourceMessageId');
  if (record.inReplyTo.length > 998 || record.referencesHeader.length > 2048) {
    throw new DatabaseInputError('threadHeaders', 'exceed the outbound provider header limit');
  }
  if (record.rawSize < 0 || record.rawSize > 25 * 1024 * 1024) {
    throw new DatabaseInputError('rawSize', 'must not exceed 25 MiB');
  }
  if (record.recipients.length < 1 || record.recipients.length > 50) {
    throw new DatabaseInputError('recipients', 'must contain between 1 and 50 addresses');
  }
  for (const recipient of record.recipients) {
    normalizeEmailAddress(recipient.address, `${recipient.kind}[${recipient.ordinal}]`);
  }
  validateOutboundAttachments(record.attachments);
}

export function recipientsOfKind(
  recipients: OutboundRecipient[],
  kind: OutboundRecipient['kind'],
): string[] {
  return recipients.filter((recipient) => recipient.kind === kind).map((recipient) => recipient.address);
}

function senderName(sender: string, address: string): string {
  const suffix = ` <${address}>`;
  return sender.endsWith(suffix) ? sender.slice(0, -suffix.length) : address;
}
