import { isMailboxRole } from './domain.js';
import type {
  WebAttachment,
  WebMessageDetail,
  WebMessageSummary,
} from './web-message-domain.js';

export type WebMessageRow = {
  id: string;
  mailbox_id: string;
  direction: string;
  status: string;
  subject: string;
  sender: string;
  recipients: string;
  received_at: number;
  text_preview: string;
  raw_size: number;
  attachment_count: number;
  is_read: number;
  is_starred: number;
  is_archived: number;
  is_deleted: number;
};

export function toWebMessageSummary(row: WebMessageRow): WebMessageSummary {
  if (
    (row.direction !== 'inbound' && row.direction !== 'outbound')
    || !['ready', 'quarantined', 'draft', 'queued', 'sending', 'sent', 'failed']
      .includes(row.status)
  ) {
    throw new Error('D1 returned an unsupported web message state');
  }
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    direction: row.direction,
    status: row.status as WebMessageSummary['status'],
    subject: row.subject,
    sender: row.sender,
    recipients: row.recipients,
    receivedAt: row.received_at,
    textPreview: row.text_preview,
    rawSize: row.raw_size,
    attachmentCount: row.attachment_count,
    isRead: row.is_read === 1,
    isStarred: row.is_starred === 1,
    isArchived: row.is_archived === 1,
    isDeleted: row.is_deleted === 1,
  };
}

export function toWebMessageDetail(
  row: WebMessageRow & Omit<WebMessageDetailRow, keyof WebMessageRow>,
): WebMessageDetail {
  if (!isMailboxRole(row.role)) throw new Error('D1 returned an unsupported mailbox role');
  return {
    ...toWebMessageSummary(row),
    role: row.role,
    processingError: row.processing_error,
    envelopeFrom: row.envelope_from,
    deliveredTo: row.delivered_to,
    rfcMessageId: row.rfc_message_id,
    inReplyTo: row.in_reply_to,
    referencesHeader: row.references_header,
    cc: row.cc,
    replyTo: row.reply_to,
    dateHeader: row.date_header,
    rawKey: row.raw_key,
    bodyTextKey: row.body_text_key,
    bodyHtmlKey: row.body_html_key,
  };
}

export type WebMessageDetailRow = WebMessageRow & {
  role: string;
  processing_error: string;
  envelope_from: string;
  delivered_to: string;
  rfc_message_id: string;
  in_reply_to: string;
  references_header: string;
  cc: string;
  reply_to: string;
  date_header: string;
  raw_key: string;
  body_text_key: string | null;
  body_html_key: string | null;
};

export function toWebAttachment(row: WebAttachmentRow): WebAttachment {
  if (!['attachment', 'inline', 'unspecified'].includes(row.disposition)) {
    throw new Error('D1 returned an unsupported attachment disposition');
  }
  return {
    ordinal: row.ordinal,
    filename: row.filename,
    contentType: row.content_type,
    disposition: row.disposition as WebAttachment['disposition'],
    contentId: row.content_id,
    size: row.size,
    sha256: row.sha256,
    storageKey: row.storage_key,
  };
}

export type WebAttachmentRow = Omit<WebAttachment, 'contentType' | 'contentId' | 'storageKey'> & {
  content_type: string;
  content_id: string;
  storage_key: string;
};
