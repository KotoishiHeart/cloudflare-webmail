import {
  WEB_MESSAGE_QUICK_FILTERS,
  type WebMessageListQuery,
} from '@cf-webmail/database';
import { ApiInputError, cursorFromUrl, limitFromUrl } from './api-input.js';

export function messageListQueryFromUrl(
  url: URL,
  folder: WebMessageListQuery['folder'],
  now: number,
): WebMessageListQuery {
  const query = boundedParam(url, 'q', 200);
  const from = boundedParam(url, 'from', 320);
  const to = boundedParam(url, 'to', 320);
  const domain = normalizeDomain(url.searchParams.get('domain'));
  const dateFrom = parseJstDate(url.searchParams.get('dateFrom'), 'dateFrom');
  const dateTo = parseJstDate(url.searchParams.get('dateTo'), 'dateTo');
  const attachment = enumParam(url, 'attachment', ['any', 'with', 'without'] as const, 'any');
  const read = enumParam(url, 'read', ['any', 'read', 'unread'] as const, 'any');
  const starred = enumParam(url, 'starred', ['any', 'starred', 'unstarred'] as const, 'any');
  const quickFilter = enumParam(url, 'filter', WEB_MESSAGE_QUICK_FILTERS, 'all');
  const minimumBytes = kilobytesParam(url, 'minKb');
  const maximumBytes = kilobytesParam(url, 'maxKb');
  if (minimumBytes !== null && maximumBytes !== null && minimumBytes > maximumBytes) {
    throw new ApiInputError('minKb must not exceed maxKb');
  }
  if (!Number.isSafeInteger(now) || now <= 0) throw new ApiInputError('invalid current time');
  return {
    folder,
    limit: limitFromUrl(url),
    cursor: cursorFromUrl(url),
    filters: {
      query,
      from,
      to,
      domain,
      dateFrom,
      dateToExclusive: dateTo === null ? null : dateTo + 24 * 60 * 60 * 1000,
      attachment,
      read,
      starred,
      minimumBytes,
      maximumBytes,
      quickFilter,
      todayStart: startOfTodayJst(now),
      sevenDaysAgo: now - 7 * 24 * 60 * 60 * 1000,
    },
  };
}

function boundedParam(url: URL, name: string, maximum: number): string {
  const value = (url.searchParams.get(name) ?? '').trim();
  if (value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ApiInputError(`invalid ${name}`);
  }
  return value;
}

function normalizeDomain(value: string | null): string {
  const domain = (value ?? '').trim().toLowerCase().replace(/^@+/u, '');
  if (domain === '') return '';
  if (domain.length > 255 || !/^[a-z0-9.-]+\.[a-z0-9-]+$/u.test(domain)) {
    throw new ApiInputError('invalid domain');
  }
  return domain;
}

function enumParam<const T extends readonly string[]>(
  url: URL,
  name: string,
  values: T,
  fallback: T[number],
): T[number] {
  const value = url.searchParams.get(name);
  if (value === null || value === '') return fallback;
  if (!values.some((candidate) => candidate === value)) {
    throw new ApiInputError(`invalid ${name}`);
  }
  return value as T[number];
}

function kilobytesParam(url: URL, name: string): number | null {
  const value = url.searchParams.get(name);
  if (value === null || value === '') return null;
  if (!/^\d{1,8}$/u.test(value)) throw new ApiInputError(`invalid ${name}`);
  const kilobytes = Number(value);
  if (!Number.isSafeInteger(kilobytes) || kilobytes < 1 || kilobytes > 10_000_000) {
    throw new ApiInputError(`invalid ${name}`);
  }
  return kilobytes * 1024;
}

function parseJstDate(value: string | null, name: string): number | null {
  if (value === null || value === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) throw new ApiInputError(`invalid ${name}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  const checked = new Date(utc);
  if (
    checked.getUTCFullYear() !== year
    || checked.getUTCMonth() !== month - 1
    || checked.getUTCDate() !== day
  ) {
    throw new ApiInputError(`invalid ${name}`);
  }
  return utc - 9 * 60 * 60 * 1000;
}

function startOfTodayJst(now: number): number {
  const jst = new Date(now + 9 * 60 * 60 * 1000);
  return Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate())
    - 9 * 60 * 60 * 1000;
}
