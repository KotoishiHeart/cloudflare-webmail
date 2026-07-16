import type {
  WebMessageCursor,
  WebMessageFlagPatch,
} from '@cf-webmail/database';

const MAX_PATCH_BYTES = 4096;

export function cursorFromUrl(url: URL): WebMessageCursor | null {
  const before = url.searchParams.get('before');
  const beforeId = url.searchParams.get('beforeId');
  if (before === null && beforeId === null) return null;
  if (before === null || beforeId === null || !/^\d+$/u.test(before)) {
    throw new ApiInputError('invalid message cursor');
  }
  const timestamp = Number(before);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new ApiInputError('invalid message cursor');
  }
  return { before: timestamp, beforeId };
}

export function limitFromUrl(url: URL): number {
  const value = url.searchParams.get('limit');
  if (value === null) return 30;
  if (!/^\d{1,3}$/u.test(value)) throw new ApiInputError('invalid message limit');
  const limit = Number(value);
  if (limit < 1 || limit > 50) throw new ApiInputError('invalid message limit');
  return limit;
}

export async function readFlagPatch(request: Request): Promise<WebMessageFlagPatch> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new UnsupportedMediaTypeError();
  }
  const input = await readBoundedJson(request, MAX_PATCH_BYTES);
  if (!isRecord(input)) throw new ApiInputError('message patch must be an object');
  const allowed = ['isRead', 'isStarred', 'isArchived', 'isDeleted'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new ApiInputError('message patch contains an unknown field');
  }
  const patch: WebMessageFlagPatch = {};
  for (const key of allowed) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new ApiInputError(`${key} must be boolean`);
    Object.assign(patch, { [key]: value });
  }
  if (Object.keys(patch).length === 0) throw new ApiInputError('message patch is empty');
  return patch;
}

export function requestIsSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && origin === new URL(request.url).origin;
}

export class UnsupportedMediaTypeError extends Error {}
export class ApiInputError extends Error {}

async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (request.body === null) throw new ApiInputError('request body is required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('request body too large');
      throw new ApiInputError('request body is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiInputError('request body must be valid JSON');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
