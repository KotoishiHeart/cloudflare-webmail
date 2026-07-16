import type { ComposeInput } from './compose-input.js';

export const MAX_OUTBOUND_ARCHIVE_BYTES = 5 * 1024 * 1024;

export type OutboundArchive = {
  raw: Uint8Array;
  html: string;
  archiveMessageId: string;
};

export function buildOutboundArchive(
  messageId: string,
  senderAddress: string,
  senderName: string,
  input: ComposeInput,
  createdAt: number,
): OutboundArchive {
  const boundary = `cf-webmail-${messageId}`;
  const archiveMessageId = `<${messageId}@archive.cf-webmail.invalid>`;
  const html = `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(input.text)}</pre>`;
  const headers = [
    `Date: ${new Date(createdAt).toUTCString()}`,
    `Message-ID: ${archiveMessageId}`,
    `From: ${encodedPhrase(senderName)} <${senderAddress}>`,
    `To: ${input.to.join(', ')}`,
    ...(input.cc.length > 0 ? [`Cc: ${input.cc.join(', ')}`] : []),
    `Subject: ${encodedPhrase(input.subject)}`,
    'MIME-Version: 1.0',
    'X-CF-Webmail-Archive: compose-snapshot',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const raw = [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(input.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { raw: new TextEncoder().encode(raw), html, archiveMessageId };
}

function encodedPhrase(value: string): string {
  if (value === '') return '';
  return `=?UTF-8?B?${base64(value)}?=`;
}

function base64Lines(value: string): string {
  return base64(value).match(/.{1,76}/gu)?.join('\r\n') ?? '';
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
