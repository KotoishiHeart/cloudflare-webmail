import type {
  OutboundDeliveryMessage,
  OutboundDeliveryStatus,
} from './outbound-domain.js';
import { listOutboundDeliveryAttachments } from './outbound-attachments.js';
import { normalizeId } from './validation.js';

type DeliveryRow = {
  message_id: string;
  mailbox_id: string;
  status: string;
  idempotency_key: string;
  provider_message_id: string;
  created_at: number;
  sender_address: string;
  sender_name: string;
  subject: string;
  body_text_key: string;
  body_html_key: string;
  in_reply_to: string;
  references_header: string;
  attempt_count: number;
  next_attempt_at: number;
  lease_expires_at: number;
  lease_token: string;
};

type RecipientRow = {
  kind: string;
  ordinal: number;
  address: string;
};

export async function getOutboundDeliveryMessage(
  db: D1Database,
  messageIdInput: string,
  mailboxIdInput: string,
): Promise<OutboundDeliveryMessage | null> {
  const messageId = normalizeId(messageIdInput, 'messageId');
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const row = await db.prepare(`
    SELECT od.message_id, od.mailbox_id, od.status, od.idempotency_key,
      od.provider_message_id, od.created_at, od.attempt_count,
      od.next_attempt_at, od.lease_expires_at, od.lease_token,
      od.sender_address, od.sender_name,
      m.subject, m.body_text_key, m.body_html_key,
      m.in_reply_to, m.references_header
    FROM outbound_deliveries AS od
    JOIN messages AS m
      ON m.id = od.message_id AND m.mailbox_id = od.mailbox_id
    WHERE od.message_id = ? AND od.mailbox_id = ?
    LIMIT 1
  `).bind(messageId, mailboxId).first<DeliveryRow>();
  if (row === null) return null;
  if (row.body_text_key === null || row.body_html_key === null) {
    throw new Error('outbound body object keys are missing');
  }
  const recipients = await db.prepare(`
    SELECT kind, ordinal, address
    FROM outbound_recipients
    WHERE message_id = ?
    ORDER BY CASE kind WHEN 'to' THEN 0 WHEN 'cc' THEN 1 ELSE 2 END, ordinal
  `).bind(messageId).all<RecipientRow>();
  const attachments = await listOutboundDeliveryAttachments(db, messageId);
  const grouped = { to: [] as string[], cc: [] as string[], bcc: [] as string[] };
  for (const recipient of recipients.results) {
    if (recipient.kind !== 'to' && recipient.kind !== 'cc' && recipient.kind !== 'bcc') {
      throw new Error('D1 returned an unsupported outbound recipient kind');
    }
    grouped[recipient.kind].push(recipient.address);
  }
  return {
    messageId: row.message_id,
    mailboxId: row.mailbox_id,
    status: requireDeliveryStatus(row.status),
    idempotencyKey: row.idempotency_key,
    providerMessageId: row.provider_message_id,
    createdAt: row.created_at,
    senderAddress: row.sender_address,
    senderName: row.sender_name,
    subject: row.subject,
    bodyTextKey: row.body_text_key,
    bodyHtmlKey: row.body_html_key,
    inReplyTo: row.in_reply_to,
    referencesHeader: row.references_header,
    attachments,
    ...grouped,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseExpiresAt: row.lease_expires_at,
    leaseToken: row.lease_token,
  };
}

function requireDeliveryStatus(status: string): OutboundDeliveryStatus {
  if (status !== 'queued' && status !== 'sending' && status !== 'sent' && status !== 'failed') {
    throw new Error('D1 returned an unsupported outbound status');
  }
  return status;
}
