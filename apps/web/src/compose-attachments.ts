import { ApiInputError, isRecord } from './api-input.js';

export const MAX_SEND_ATTACHMENTS = 8;
export const MAX_SEND_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_SEND_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_SEND_REQUEST_BYTES = MAX_SEND_TOTAL_ATTACHMENT_BYTES + 2 * 1024 * 1024;

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const PROHIBITED_EXTENSIONS = new Set([
  'ade', 'adp', 'apk', 'app', 'bat', 'cmd', 'com', 'cpl',
  'dll', 'dmg', 'exe', 'hta', 'ins', 'isp', 'jar', 'js', 'jse',
  'lib', 'lnk', 'mde', 'msc', 'msi', 'msp', 'mst', 'pif',
  'ps1', 'scr', 'sh', 'sys', 'vb', 'vbe', 'vbs', 'ws', 'wsc', 'wsf', 'wsh',
]);
const PROHIBITED_MIME_PREFIXES = [
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-ms-installer',
  'application/x-sh',
  'application/x-executable',
];

export type ComposeAttachment = {
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  bytes: Uint8Array;
};

export async function readMultipartComposeInput(request: Request): Promise<{
  payload: Record<string, unknown>;
  attachments: ComposeAttachment[];
}> {
  rejectOversizedRequest(request.headers.get('content-length'));
  const form = await readBoundedFormData(request);
  let containsUnknownField = false;
  form.forEach((_value, key) => {
    if (key !== 'payload' && key !== 'attachments') containsUnknownField = true;
  });
  if (containsUnknownField) throw new ApiInputError('compose form contains an unknown field');
  const payloadEntries = form.getAll('payload');
  if (payloadEntries.length !== 1 || typeof payloadEntries[0] !== 'string') {
    throw new ApiInputError('compose form must contain one JSON payload field');
  }
  const payloadText = payloadEntries[0];
  if (new TextEncoder().encode(payloadText).byteLength > MAX_PAYLOAD_BYTES) {
    throw new ApiInputError('compose payload is too large');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw new ApiInputError('compose payload must be valid JSON');
  }
  if (!isRecord(payload)) throw new ApiInputError('compose payload must be an object');
  return { payload, attachments: await readAttachments(form.getAll('attachments')) };
}

async function readAttachments(entries: FormDataEntryValue[]): Promise<ComposeAttachment[]> {
  const files = entries.filter((entry): entry is File => {
    if (typeof entry === 'string') throw new ApiInputError('attachments must be files');
    return entry.name !== '' || entry.size !== 0;
  });
  if (files.length > MAX_SEND_ATTACHMENTS) {
    throw new ApiInputError(`attachments must contain at most ${MAX_SEND_ATTACHMENTS} files`);
  }
  const attachments: ComposeAttachment[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const filename = cleanFilename(file.name);
    const contentType = cleanContentType(file.type, filename);
    if (file.size > MAX_SEND_ATTACHMENT_BYTES) {
      throw new ApiInputError(`${filename} exceeds the per-attachment size limit`);
    }
    totalBytes += file.size;
    if (totalBytes > MAX_SEND_TOTAL_ATTACHMENT_BYTES) {
      throw new ApiInputError('attachments exceed the total size limit');
    }
    if (isProhibited(filename, contentType)) {
      throw new ApiInputError(`${filename} is a prohibited attachment type`);
    }
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    attachments.push({
      filename,
      contentType,
      size: bytes.byteLength,
      sha256: await sha256Hex(buffer),
      bytes,
    });
  }
  return attachments;
}

function rejectOversizedRequest(value: string | null): void {
  if (value === null || !/^\d+$/u.test(value)) return;
  if (Number(value) > MAX_SEND_REQUEST_BYTES) {
    throw new ApiInputError('compose form is too large');
  }
}

async function readBoundedFormData(request: Request): Promise<FormData> {
  if (request.body === null) throw new ApiInputError('compose form body is required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SEND_REQUEST_BYTES) {
      await reader.cancel('compose form is too large');
      throw new ApiInputError('compose form is too large');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Request(request.url, {
      method: 'POST',
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
      body,
    }).formData();
  } catch {
    throw new ApiInputError('compose form must be valid multipart data');
  }
}

function cleanFilename(value: string): string {
  const cleaned = value.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\]/gu, '_').trim();
  return Array.from(cleaned).slice(0, 255).join('') || 'attachment.bin';
}

function cleanContentType(value: string, filename: string): string {
  const normalized = value.trim().toLowerCase().split(';', 1)[0]?.trim() ?? '';
  if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized)) return normalized;
  return guessedContentType(filename);
}

function guessedContentType(filename: string): string {
  const extension = filename.toLowerCase().split('.').pop() ?? '';
  const known: Record<string, string> = {
    csv: 'text/csv', gif: 'image/gif', gz: 'application/gzip', htm: 'text/html',
    html: 'text/html', jpeg: 'image/jpeg', jpg: 'image/jpeg', json: 'application/json',
    pdf: 'application/pdf', png: 'image/png', svg: 'image/svg+xml', txt: 'text/plain',
    webp: 'image/webp', xml: 'application/xml', zip: 'application/zip',
  };
  return known[extension] ?? 'application/octet-stream';
}

function isProhibited(filename: string, contentType: string): boolean {
  const extension = filename.toLowerCase().split('.').pop() ?? '';
  return PROHIBITED_EXTENSIONS.has(extension)
    || PROHIBITED_MIME_PREFIXES.some((prefix) => contentType.startsWith(prefix));
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
