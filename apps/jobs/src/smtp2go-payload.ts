import type { OutboundMailerAttachment, OutboundMailerMessage } from './outbound-mailer.js';

export function createSmtp2goPayload(message: OutboundMailerMessage): Record<string, unknown> {
  return {
    sender: sender(message.from),
    ...(message.to === undefined ? {} : { to: message.to }),
    ...(message.cc === undefined ? {} : { cc: message.cc }),
    ...(message.bcc === undefined ? {} : { bcc: message.bcc }),
    subject: message.subject,
    text_body: message.text,
    html_body: message.html,
    custom_headers: Object.entries(message.headers).map(([header, value]) => ({ header, value })),
    ...(message.attachments === undefined
      ? {}
      : { attachments: message.attachments.map(providerAttachment) }),
  };
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
