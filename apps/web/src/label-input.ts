import type { UserPreferences } from '@cf-webmail/database';
import {
  ApiInputError,
  isRecord,
  readBoundedJson,
  UnsupportedMediaTypeError,
} from './api-input.js';

const MAX_LABEL_INPUT_BYTES = 8 * 1024;

export type LabelPatch = {
  name?: string;
  color?: string;
  description?: string;
};

export async function readLabelPatch(request: Request, requireName: boolean): Promise<LabelPatch> {
  const input = await readJsonObject(request);
  rejectUnknown(input, ['name', 'color', 'description']);
  const result: LabelPatch = {};
  if (input.name !== undefined) {
    if (typeof input.name !== 'string') throw new ApiInputError('label name must be a string');
    result.name = input.name;
  }
  if (input.color !== undefined) {
    if (typeof input.color !== 'string') throw new ApiInputError('label color must be a string');
    result.color = input.color;
  }
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') {
      throw new ApiInputError('label description must be a string');
    }
    result.description = input.description;
  }
  if (requireName && result.name === undefined) throw new ApiInputError('label name is required');
  if (Object.keys(result).length === 0) throw new ApiInputError('label patch is empty');
  return result;
}

export async function readMessageLabelIds(request: Request): Promise<string[]> {
  const input = await readJsonObject(request);
  rejectUnknown(input, ['labelIds']);
  if (!Array.isArray(input.labelIds) || input.labelIds.length > 20) {
    throw new ApiInputError('labelIds must be an array with at most 20 values');
  }
  return input.labelIds.map((value, index) => {
    if (typeof value !== 'string') throw new ApiInputError(`labelIds[${index}] must be a string`);
    return value;
  });
}

export async function readPreferencePatch(request: Request): Promise<Partial<UserPreferences>> {
  const input = await readJsonObject(request);
  const allowed = [
    'theme', 'pageSize', 'defaultFolder', 'defaultMailboxId',
    'showHtmlByDefault', 'compactLayout',
  ];
  rejectUnknown(input, allowed);
  const patch: Record<string, unknown> = {};
  for (const key of allowed) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (Object.keys(patch).length === 0) throw new ApiInputError('preference patch is empty');
  return patch as Partial<UserPreferences>;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new UnsupportedMediaTypeError();
  const input = await readBoundedJson(request, MAX_LABEL_INPUT_BYTES);
  if (!isRecord(input)) throw new ApiInputError('request body must be an object');
  return input;
}

function rejectUnknown(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new ApiInputError('request contains an unknown field');
  }
}
