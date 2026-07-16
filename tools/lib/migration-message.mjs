import { createHash } from 'node:crypto';
import PostalMime from 'postal-mime';

const CONTROL = /[\u0000-\u001f\u007f]+/gu;

export async function prepareMigratedMessage(raw, options) {
  const rawSha256 = sha256(raw);
  const messageId = deterministicUuid(`${options.mailboxId}\u0000${rawSha256}`);
  let parsed = null;
  let processingError = '';
  try {
    parsed = await PostalMime.parse(raw, {
      attachmentEncoding: 'arraybuffer',
      maxNestingDepth: 64,
      maxHeadersSize: 512 * 1024,
    });
    if (parsed.attachments.length > 100) {
      parsed = null;
      processingError = 'attachment-limit-exceeded';
    }
  } catch {
    processingError = 'migration-parse-failed';
  }
  const prefix = `mailboxes/${options.mailboxId}/messages/${messageId}`;
  const bodyText = parsed?.text ?? '';
  const bodyHtml = parsed?.html ?? '';
  const attachments = [];
  for (const [ordinal, attachment] of (parsed?.attachments ?? []).entries()) {
    const content = toBuffer(attachment.content);
    attachments.push({
      ordinal,
      filename: clean(attachment.filename ?? 'attachment.bin', 255)
        .replaceAll('/', '_').replaceAll('\\', '_') || 'attachment.bin',
      contentType: clean(attachment.mimeType || 'application/octet-stream', 255),
      disposition: attachment.disposition ?? 'unspecified',
      contentId: clean(attachment.contentId ?? '', 998),
      size: content.byteLength,
      sha256: sha256(content),
      key: `${prefix}/attachments/${String(ordinal).padStart(3, '0')}`,
      content,
    });
  }
  const dateValue = parsed?.date ? Date.parse(parsed.date) : Number.NaN;
  const receivedAt = Number.isSafeInteger(dateValue) && dateValue > 0
    ? dateValue
    : options.modifiedAt;
  const direction = options.direction;
  const status = direction === 'outbound'
    ? 'sent'
    : processingError === '' ? 'ready' : 'quarantined';
  const sender = clean(formatAddress(parsed?.from) || parsed?.returnPath || '', 2048);
  const recipients = clean(formatAddresses(parsed?.to) || options.address, 8192);
  return {
    id: messageId,
    mailboxId: options.mailboxId,
    direction,
    status,
    processingError,
    envelopeFrom: clean(parsed?.returnPath || mailboxAddress(parsed?.from), 320),
    deliveredTo: options.address,
    rfcMessageId: clean(parsed?.messageId ?? '', 998),
    inReplyTo: clean(parsed?.inReplyTo ?? '', 998),
    referencesHeader: clean(parsed?.references ?? '', 8192),
    subject: clean(parsed?.subject ?? '', 998),
    sender,
    recipients,
    cc: clean(formatAddresses(parsed?.cc), 8192),
    replyTo: clean(formatAddresses(parsed?.replyTo), 4096),
    dateHeader: clean(parsed?.date ?? '', 256),
    receivedAt,
    textPreview: clean(bodyText || textFromHtml(bodyHtml), 1024),
    rawKey: `${prefix}/raw.eml`,
    rawSha256,
    rawEtag: `import-sha256:${rawSha256}`,
    rawSize: raw.byteLength,
    bodyTextKey: bodyText === '' ? null : `${prefix}/body.txt`,
    bodyHtmlKey: bodyHtml === '' ? null : `${prefix}/body.html`,
    bodyText,
    bodyHtml,
    attachments,
    flags: options.flags,
    raw,
  };
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicUuid(seed) {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toBuffer(content) {
  if (typeof content === 'string') return Buffer.from(content);
  if (content instanceof Uint8Array) return Buffer.from(content);
  return Buffer.from(new Uint8Array(content));
}

function clean(value, maximum) {
  return String(value).replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function formatAddresses(addresses) {
  return addresses?.map(formatAddress).filter(Boolean).join(', ') ?? '';
}

function formatAddress(address) {
  if (!address) return '';
  if (Array.isArray(address.group)) {
    return `${clean(address.name, 512)}: ${address.group.map(formatAddress).join(', ')};`;
  }
  const name = clean(address.name ?? '', 512);
  const mailbox = clean(address.address ?? '', 320);
  return name === '' ? mailbox : mailbox === '' ? name : `${name} <${mailbox}>`;
}

function mailboxAddress(address) {
  if (!address || Array.isArray(address.group)) return '';
  return address.address ?? '';
}

function textFromHtml(value) {
  return value.replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ');
}
