import type { OutboundMailerAttachment, OutboundMailerMessage } from './outbound-mailer.js';

const MAX_CUSTOM_HEADER_VALUE_LENGTH = 255;

export function createSmtp2goPayload(message: OutboundMailerMessage): Record<string, unknown> {
  return {
    sender: sender(message.from),
    ...(message.to === undefined ? {} : { to: message.to }),
    ...(message.cc === undefined ? {} : { cc: message.cc }),
    ...(message.bcc === undefined ? {} : { bcc: message.bcc }),
    subject: message.subject,
    text_body: message.text,
    html_body: message.html,
    custom_headers: createSmtp2goHeaders(message.headers),
    ...(message.attachments === undefined
      ? {}
      : { attachments: message.attachments.map(providerAttachment) }),
  };
}

export type Smtp2goHeader = { header: string; value: string };

export function createSmtp2goHeaders(headers: Record<string, string>): Smtp2goHeader[] {
  return Object.entries(headers).flatMap(([header, value]) => {
    if (header.toLowerCase() !== 'references') return [{ header, value }];
    const fitted = fitReferencesHeader(value);
    return fitted === '' ? [] : [{ header, value: fitted }];
  });
}

function fitReferencesHeader(value: string): string {
  const messageIds = value.match(/<[^<>\r\n]{1,996}>/gu) ?? [];
  const fitted: string[] = [];
  for (let index = messageIds.length - 1; index >= 0; index -= 1) {
    const candidate = [messageIds[index], ...fitted].join(' ');
    if (candidate.length > MAX_CUSTOM_HEADER_VALUE_LENGTH) break;
    fitted.unshift(messageIds[index] as string);
  }
  return fitted.join(' ');
}

function sender(from: OutboundMailerMessage['from']): string {
  if (from.name === '') return from.email;
  return `"${from.name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" <${from.email}>`;
}

function providerAttachment(attachment: OutboundMailerAttachment): Record<string, string> {
  return {
    filename: attachment.filename,
    mimetype: attachment.type,
    fileblob: arrayBufferToBase64(attachment.content),
  };
}

function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}
