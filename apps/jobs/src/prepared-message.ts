import type { InboundQueueMessage } from '@cf-webmail/contracts';
import type {
  AttachmentDisposition,
  InboundAttachmentRecord,
  InboundMessageRecord,
  MessageStatus,
} from '@cf-webmail/database';
import type { Attachment, Email } from 'postal-mime';
import { sha256Hex } from './hashing.js';
import {
  cleanMailField,
  formatMailAddress,
  formatMailAddresses,
  textFromHtml,
} from './mail-fields.js';

const MAX_ATTACHMENTS = 100;
const MESSAGE_PREVIEW_LENGTH = 1024;

export type PreparedAttachment = InboundAttachmentRecord & { content: Uint8Array };

export type PreparedMessage = {
  rawKey: string;
  bodyTextKey: string | null;
  bodyHtmlKey: string | null;
  bodyText: string;
  bodyHtml: string;
  attachments: PreparedAttachment[];
  status: MessageStatus;
  processingError: string;
  parsed: Email | null;
};

export async function prepareMessage(
  queueMessage: InboundQueueMessage,
  parsed: Email | null,
  parseErrorType: string | null,
  now: number,
): Promise<PreparedMessage> {
  const prefix = messagePrefix(queueMessage.mailboxId, queueMessage.messageId);
  const extractionError = parseErrorType !== null
    ? 'mime-parse-failed'
    : parsed !== null && parsed.attachments.length > MAX_ATTACHMENTS
      ? 'attachment-limit-exceeded'
      : '';
  const canExtract = parsed !== null && extractionError === '';
  const bodyText = canExtract ? parsed.text ?? '' : '';
  const bodyHtml = canExtract ? parsed.html ?? '' : '';
  const attachments = canExtract
    ? await prepareAttachments(parsed.attachments, prefix, now)
    : [];
  return {
    rawKey: `${prefix}/raw.eml`,
    bodyTextKey: bodyText === '' ? null : `${prefix}/body.txt`,
    bodyHtmlKey: bodyHtml === '' ? null : `${prefix}/body.html`,
    bodyText,
    bodyHtml,
    attachments,
    status: queueMessage.routing.action === 'quarantine' || extractionError !== ''
      ? 'quarantined'
      : 'ready',
    processingError: extractionError,
    parsed,
  };
}

export function toMessageRecord(
  queueMessage: InboundQueueMessage,
  prepared: PreparedMessage,
  rawSha256: string,
  rawEtag: string,
  now: number,
): InboundMessageRecord {
  const email = prepared.parsed;
  const previewSource = email?.text || textFromHtml(email?.html ?? '');
  return {
    id: queueMessage.messageId,
    mailboxId: queueMessage.mailboxId,
    status: prepared.status,
    processingError: prepared.processingError,
    envelopeFrom: cleanMailField(queueMessage.envelope.from, 320),
    deliveredTo: queueMessage.accountEmail,
    rfcMessageId: cleanMailField(email?.messageId ?? queueMessage.headers.messageId, 998),
    inReplyTo: cleanMailField(email?.inReplyTo ?? '', 998),
    referencesHeader: cleanMailField(email?.references ?? '', 8192),
    subject: cleanMailField(email?.subject ?? queueMessage.headers.subject, 998),
    sender: cleanMailField(
      email?.from ? formatMailAddress(email.from) : queueMessage.envelope.from,
      2048,
    ),
    recipients: cleanMailField(
      formatMailAddresses(email?.to) || queueMessage.accountEmail,
      8192,
    ),
    cc: cleanMailField(formatMailAddresses(email?.cc), 8192),
    replyTo: cleanMailField(formatMailAddresses(email?.replyTo), 4096),
    dateHeader: cleanMailField(email?.date ?? '', 256),
    receivedAt: queueMessage.receivedAt,
    textPreview: cleanMailField(previewSource, MESSAGE_PREVIEW_LENGTH),
    rawKey: prepared.rawKey,
    rawSha256,
    rawEtag,
    rawSize: queueMessage.staging.rawSize,
    bodyTextKey: prepared.bodyTextKey,
    bodyHtmlKey: prepared.bodyHtmlKey,
    attachments: prepared.attachments,
    createdAt: now,
  };
}

function messagePrefix(mailboxId: string, messageId: string): string {
  return `mailboxes/${mailboxId}/messages/${messageId}`;
}

async function prepareAttachments(
  attachments: Attachment[],
  prefix: string,
  now: number,
): Promise<PreparedAttachment[]> {
  const prepared: PreparedAttachment[] = [];
  for (const [ordinal, attachment] of attachments.entries()) {
    const content = toBytes(attachment.content);
    prepared.push({
      ordinal,
      filename: cleanFilename(attachment.filename),
      contentType: cleanMailField(attachment.mimeType || 'application/octet-stream', 255),
      disposition: attachment.disposition ?? 'unspecified' satisfies AttachmentDisposition,
      contentId: cleanMailField(attachment.contentId ?? '', 998),
      size: content.byteLength,
      sha256: await sha256Hex(content),
      storageKey: `${prefix}/attachments/${ordinal.toString().padStart(3, '0')}`,
      createdAt: now,
      content,
    });
  }
  return prepared;
}

function toBytes(content: Attachment['content']): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

function cleanFilename(value: string | null): string {
  return cleanMailField(value ?? 'attachment.bin', 255).replaceAll('/', '_').replaceAll('\\', '_')
    || 'attachment.bin';
}
