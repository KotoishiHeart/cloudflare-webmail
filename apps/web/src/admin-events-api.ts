import {
  getAdminSummary,
  listAdminAuditEvents,
  listAdminDeliveryEvents,
  type AdminEventCursor,
} from '@cf-webmail/database';
import { ApiInputError } from './api-input.js';
import { apiData } from './api-response.js';

export async function adminSummary(db: D1Database, now: number): Promise<Response> {
  return apiData({ summary: await getAdminSummary(db, now) });
}

export async function adminAuditEvents(request: Request, db: D1Database): Promise<Response> {
  const url = new URL(request.url);
  return apiData({
    events: await listAdminAuditEvents(db, {
      limit: eventLimit(url),
      ...optionalParam(url, 'category'),
      ...optionalParam(url, 'severity'),
      ...optionalParam(url, 'actorUserId'),
      ...optionalParam(url, 'mailboxId'),
      ...cursor(url),
    }),
  });
}

export async function adminDeliveryEvents(request: Request, db: D1Database): Promise<Response> {
  const url = new URL(request.url);
  return apiData({
    events: await listAdminDeliveryEvents(db, {
      limit: eventLimit(url),
      ...optionalParam(url, 'direction'),
      ...optionalParam(url, 'status'),
      ...optionalParam(url, 'mailboxId'),
      ...optionalParam(url, 'messageId'),
      ...cursor(url),
    }),
  });
}

function eventLimit(url: URL): number {
  const value = url.searchParams.get('limit');
  if (value === null) return 50;
  if (!/^\d{1,3}$/u.test(value)) throw new ApiInputError('limit is invalid');
  const limit = Number(value);
  if (limit < 1 || limit > 100) throw new ApiInputError('limit must be between 1 and 100');
  return limit;
}

function optionalParam(url: URL, name: string): Record<string, string> {
  const value = url.searchParams.get(name);
  return value === null || value === '' ? {} : { [name]: value };
}

function cursor(url: URL): { cursor?: AdminEventCursor } {
  const before = url.searchParams.get('before');
  const beforeId = url.searchParams.get('beforeId');
  if (before === null && beforeId === null) return {};
  if (before === null || beforeId === null || !/^\d+$/u.test(before) || beforeId === '') {
    throw new ApiInputError('event cursor is invalid');
  }
  const timestamp = Number(before);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new ApiInputError('event cursor is invalid');
  }
  return { cursor: { before: timestamp, beforeId } };
}
