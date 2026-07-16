import {
  normalizeEmailAddress,
  type OutboundComposeMode,
} from '@cf-webmail/database';
import { ApiInputError, isRecord, readBoundedJson } from './api-input.js';

const MAX_COMPOSE_JSON_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;

export type ComposeInput = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  composeMode: OutboundComposeMode;
  sourceMessageId: string | null;
};

export async function readComposeInput(request: Request): Promise<ComposeInput> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new ComposeMediaTypeError();
  const input = await readBoundedJson(request, MAX_COMPOSE_JSON_BYTES);
  if (!isRecord(input)) throw new ApiInputError('compose request must be an object');
  const allowed = ['to', 'cc', 'bcc', 'subject', 'text', 'composeMode', 'sourceMessageId'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new ApiInputError('compose request contains an unknown field');
  }
  const to = addressList(input.to, 'to');
  const cc = addressList(input.cc ?? [], 'cc');
  const bcc = addressList(input.bcc ?? [], 'bcc');
  const recipients = [...to, ...cc, ...bcc];
  if (recipients.length === 0 || recipients.length > 50) {
    throw new ApiInputError('compose request must contain between 1 and 50 recipients');
  }
  if (new Set(recipients).size !== recipients.length) {
    throw new ApiInputError('compose request contains a duplicate recipient');
  }
  if (typeof input.subject !== 'string' || input.subject.length > 998 || hasControl(input.subject)) {
    throw new ApiInputError('subject must not exceed 998 characters or contain control characters');
  }
  if (typeof input.text !== 'string') throw new ApiInputError('text must be a string');
  const textBytes = new TextEncoder().encode(input.text).byteLength;
  if (textBytes === 0 || textBytes > MAX_TEXT_BYTES) {
    throw new ApiInputError(`text must contain between 1 and ${MAX_TEXT_BYTES} UTF-8 bytes`);
  }
  const composeMode = readComposeMode(input.composeMode);
  const sourceMessageId = readSourceMessageId(input.sourceMessageId);
  return {
    to,
    cc,
    bcc,
    subject: input.subject.trim(),
    text: input.text,
    composeMode,
    sourceMessageId,
  };
}

export class ComposeMediaTypeError extends Error {}

function addressList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new ApiInputError(`${field} must be an array with at most 50 addresses`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new ApiInputError(`${field}[${index}] must be a string`);
    return normalizeEmailAddress(item, `${field}[${index}]`);
  });
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function readComposeMode(value: unknown): OutboundComposeMode {
  if (value === undefined) return 'new';
  if (value === 'new' || value === 'reply' || value === 'forward') return value;
  throw new ApiInputError('composeMode must be new, reply, or forward');
}

function readSourceMessageId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 128 || hasControl(value)) {
    throw new ApiInputError('sourceMessageId must be a string with at most 128 characters');
  }
  return value;
}
