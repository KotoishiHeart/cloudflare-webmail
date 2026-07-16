import { requireSha256 } from './message-queries.js';
import type {
  OutboundAttachmentRecord,
  OutboundDeliveryMessage,
} from './outbound-domain.js';
import { DatabaseInputError, requireTimestamp } from './validation.js';

type AttachmentRow = {
  ordinal: number;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  storage_key: string;
};

export function prepareOutboundAttachmentInserts(
  db: D1Database,
  messageId: string,
  attachments: OutboundAttachmentRecord[],
): D1PreparedStatement[] {
  return attachments.map((attachment) => db.prepare(`
    INSERT INTO attachments (
      message_id, ordinal, filename, content_type, disposition,
      content_id, size, sha256, storage_key, created_at
    ) VALUES (?, ?, ?, ?, 'attachment', '', ?, ?, ?, ?)
  `).bind(
    messageId,
    attachment.ordinal,
    attachment.filename,
    attachment.contentType,
    attachment.size,
    attachment.sha256,
    attachment.storageKey,
    attachment.createdAt,
  ));
}

export async function listOutboundDeliveryAttachments(
  db: D1Database,
  messageId: string,
): Promise<OutboundDeliveryMessage['attachments']> {
  const result = await db.prepare(`
    SELECT ordinal, filename, content_type, size, sha256, storage_key
    FROM attachments
    WHERE message_id = ?
    ORDER BY ordinal
  `).bind(messageId).all<AttachmentRow>();
  return result.results.map((attachment) => ({
    ordinal: attachment.ordinal,
    filename: attachment.filename,
    contentType: attachment.content_type,
    size: attachment.size,
    sha256: attachment.sha256,
    storageKey: attachment.storage_key,
  }));
}

export function validateOutboundAttachments(attachments: OutboundAttachmentRecord[]): void {
  if (attachments.length > 8) {
    throw new DatabaseInputError('attachments', 'must contain at most 8 files');
  }
  let totalBytes = 0;
  for (const [ordinal, attachment] of attachments.entries()) {
    if (attachment.ordinal !== ordinal) {
      throw new DatabaseInputError('attachments', 'must have contiguous ordinals');
    }
    boundedText(attachment.filename, 255, 'attachment.filename');
    boundedText(attachment.contentType, 255, 'attachment.contentType');
    boundedText(attachment.storageKey, 1024, 'attachment.storageKey');
    if (attachment.size < 0 || attachment.size > 10 * 1024 * 1024) {
      throw new DatabaseInputError('attachment.size', 'must not exceed 10 MiB');
    }
    requireSha256(attachment.sha256);
    requireTimestamp(attachment.createdAt, 'attachment.createdAt');
    totalBytes += attachment.size;
  }
  if (totalBytes > 20 * 1024 * 1024) {
    throw new DatabaseInputError('attachments', 'must not exceed 20 MiB in total');
  }
}

function boundedText(value: string, maximum: number, field: string): void {
  if (value.length < 1 || value.length > maximum) {
    throw new DatabaseInputError(field, `must contain 1 to ${maximum} characters`);
  }
}
