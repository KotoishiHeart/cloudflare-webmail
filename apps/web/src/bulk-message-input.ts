import type { WebMessageFlagPatch } from '@cf-webmail/database';
import { ApiInputError, isRecord, readBoundedJson } from './api-input.js';

const MAX_BULK_PATCH_BYTES = 16 * 1024;
const MAX_BULK_MESSAGES = 40;

export type BulkMessagePatch = {
  messageIds: string[];
  patch: WebMessageFlagPatch;
};

export async function readBulkMessagePatch(request: Request): Promise<BulkMessagePatch> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new BulkMessageMediaTypeError();
  const input = await readBoundedJson(request, MAX_BULK_PATCH_BYTES);
  if (!isRecord(input)) throw new ApiInputError('bulk message patch must be an object');
  if (Object.keys(input).some((key) => !['messageIds', 'patch'].includes(key))) {
    throw new ApiInputError('bulk message patch contains an unknown field');
  }
  if (
    !Array.isArray(input.messageIds)
    || input.messageIds.length < 1
    || input.messageIds.length > MAX_BULK_MESSAGES
    || input.messageIds.some((id) => typeof id !== 'string')
  ) throw new ApiInputError('messageIds must contain 1 to 40 IDs');
  const messageIds = input.messageIds.map((id) => id.trim());
  if (messageIds.some((id) => id === '') || new Set(messageIds).size !== messageIds.length) {
    throw new ApiInputError('messageIds must be nonempty and unique');
  }
  return { messageIds, patch: parsePatch(input.patch) };
}

function parsePatch(input: unknown): WebMessageFlagPatch {
  if (!isRecord(input)) throw new ApiInputError('patch must be an object');
  const allowed = ['isRead', 'isStarred', 'isArchived', 'isDeleted'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new ApiInputError('patch contains an unknown field');
  }
  const patch: WebMessageFlagPatch = {};
  for (const key of allowed) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new ApiInputError(`${key} must be boolean`);
    Object.assign(patch, { [key]: value });
  }
  if (Object.keys(patch).length !== 1) {
    throw new ApiInputError('bulk patch must change exactly one message flag');
  }
  return patch;
}

export class BulkMessageMediaTypeError extends Error {}
