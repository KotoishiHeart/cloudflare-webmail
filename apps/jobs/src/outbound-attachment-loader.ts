import type { OutboundDeliveryMessage } from '@cf-webmail/database';
import { PermanentOutboundError } from './outbound-errors.js';

export async function loadOutboundAttachments(
  bucket: Pick<R2Bucket, 'get'>,
  attachments: OutboundDeliveryMessage['attachments'],
): Promise<EmailAttachment[]> {
  return Promise.all(attachments.map(async (attachment) => {
    const object = await bucket.get(attachment.storageKey);
    if (object === null) {
      throw new Error(`outbound attachment object is missing: ${attachment.filename}`);
    }
    const content = await object.arrayBuffer();
    if (content.byteLength !== attachment.size || await sha256Hex(content) !== attachment.sha256) {
      throw new PermanentOutboundError(
        'attachment_integrity_failed',
        `outbound attachment integrity check failed: ${attachment.filename}`,
      );
    }
    return {
      disposition: 'attachment' as const,
      filename: attachment.filename,
      type: attachment.contentType,
      content,
    };
  }));
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
