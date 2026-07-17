import type { OutboundThreadContext } from '@cf-webmail/database';
import type { ComposeInput } from './compose-input.js';

export const MAX_OUTBOUND_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const MAX_OUTBOUND_ARCHIVE_SOURCE_BYTES = 40 * 1024 * 1024;
export const MAX_OUTBOUND_PROVIDER_CONTENT_BYTES = 24 * 1024 * 1024;

export type OutboundArchive = {
  raw: Uint8Array;
  html: string;
  archiveMessageId: string;
};

export type StoredOutboundArchive = {
  body: Uint8Array;
  encoding: '' | 'gzip';
};

export function buildOutboundArchive(
  messageId: string,
  senderAddress: string,
  senderName: string,
  input: ComposeInput,
  thread: OutboundThreadContext,
  createdAt: number,
): OutboundArchive {
  const alternativeBoundary = `cf-webmail-alt-${messageId}`;
  const mixedBoundary = `cf-webmail-mixed-${messageId}`;
  const archiveMessageId = `<${messageId}@archive.cf-webmail.invalid>`;
  const html = `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(input.text)}</pre>`;
  const hasAttachments = input.attachments.length > 0;
  const headers = [
    `Date: ${new Date(createdAt).toUTCString()}`,
    `Message-ID: ${archiveMessageId}`,
    `From: ${encodedPhrase(senderName)} <${senderAddress}>`,
    `To: ${input.to.join(', ')}`,
    ...(input.cc.length > 0 ? [`Cc: ${input.cc.join(', ')}`] : []),
    `Subject: ${encodedPhrase(input.subject)}`,
    ...(thread.inReplyTo === '' ? [] : [`In-Reply-To: ${thread.inReplyTo}`]),
    ...(thread.referencesHeader === '' ? [] : [`References: ${thread.referencesHeader}`]),
    'MIME-Version: 1.0',
    'X-CF-Webmail-Archive: compose-snapshot',
    `Content-Type: multipart/${hasAttachments ? 'mixed' : 'alternative'}; boundary="${hasAttachments ? mixedBoundary : alternativeBoundary}"`,
  ];
  const chunks: Uint8Array[] = [];
  appendText(chunks, `${headers.join('\r\n')}\r\n\r\n`);
  if (hasAttachments) {
    appendText(chunks, `--${mixedBoundary}\r\nContent-Type: multipart/alternative; boundary="${alternativeBoundary}"\r\n\r\n`);
  }
  appendAlternative(chunks, alternativeBoundary, input.text, html);
  for (const attachment of input.attachments) {
    appendText(chunks, [
      `--${mixedBoundary}`,
      `Content-Type: ${attachment.contentType}; ${filenameParameter('name', attachment.filename)}`,
      `Content-Disposition: attachment; ${filenameParameter('filename', attachment.filename)}`,
      'Content-Transfer-Encoding: base64',
      '',
      '',
    ].join('\r\n'));
    appendBase64(chunks, attachment.bytes);
  }
  if (hasAttachments) appendText(chunks, `--${mixedBoundary}--\r\n`);
  return { raw: concatenate(chunks), html, archiveMessageId };
}

export async function prepareArchiveForStorage(
  archive: OutboundArchive,
  compress: boolean,
): Promise<StoredOutboundArchive> {
  if (!compress) return { body: archive.raw, encoding: '' };
  const source = archive.raw.buffer as ArrayBuffer;
  const compressed = new Blob([source]).stream().pipeThrough(new CompressionStream('gzip'));
  return {
    body: new Uint8Array(await new Response(compressed).arrayBuffer()),
    encoding: 'gzip',
  };
}

export function outboundProviderContentBytes(input: ComposeInput, html: string): number {
  const encoder = new TextEncoder();
  return input.attachments.reduce((total, attachment) => total + attachment.size, 0)
    + encoder.encode(input.text).byteLength
    + encoder.encode(html).byteLength;
}

function appendAlternative(
  chunks: Uint8Array[],
  boundary: string,
  text: string,
  html: string,
): void {
  appendText(chunks, `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`);
  appendBase64(chunks, new TextEncoder().encode(text));
  appendText(chunks, `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`);
  appendBase64(chunks, new TextEncoder().encode(html));
  appendText(chunks, `--${boundary}--\r\n`);
}

function appendBase64(chunks: Uint8Array[], value: Uint8Array): void {
  const inputChunkBytes = 57 * 1024;
  for (let offset = 0; offset < value.byteLength; offset += inputChunkBytes) {
    const encoded = bytesToBase64(value.subarray(offset, offset + inputChunkBytes));
    appendText(chunks, `${encoded.match(/.{1,76}/gu)?.join('\r\n') ?? ''}\r\n`);
  }
  if (value.byteLength === 0) appendText(chunks, '\r\n');
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < value.length; offset += 8192) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function encodedPhrase(value: string): string {
  if (value === '') return '';
  return `=?UTF-8?B?${bytesToBase64(new TextEncoder().encode(value))}?=`;
}

function filenameParameter(name: string, filename: string): string {
  if (/^[\x20-\x7e]+$/u.test(filename) && !/[";\\]/u.test(filename)) {
    return `${name}="${filename}"`;
  }
  const encoded = encodeURIComponent(filename).replace(/['()*]/gu, (character) => (
    `%${character.codePointAt(0)?.toString(16).toUpperCase()}`
  ));
  return `${name}*=UTF-8''${encoded}`;
}

function appendText(chunks: Uint8Array[], value: string): void {
  chunks.push(new TextEncoder().encode(value));
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
