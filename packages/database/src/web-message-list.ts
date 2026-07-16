import { DatabaseInputError, normalizeId } from './validation.js';
import {
  WEB_MAILBOX_FOLDERS,
  type WebMailboxFolder,
  type WebMessageCursor,
  type WebMessageListQuery,
  type WebMessagePage,
  type WebMessageSearchFilters,
} from './web-message-domain.js';
import { toWebMessageSummary, type WebMessageRow } from './web-message-rows.js';

const FOLDER_WHERE: Record<WebMailboxFolder, string> = {
  inbox: "m.direction = 'inbound' AND m.is_archived = 0 AND m.is_deleted = 0",
  outbox: "m.direction = 'outbound' AND m.status IN ('draft', 'queued', 'sending', 'failed') AND m.is_deleted = 0",
  sent: "m.direction = 'outbound' AND m.status = 'sent' AND m.is_deleted = 0",
  starred: 'm.is_starred = 1 AND m.is_deleted = 0',
  archive: 'm.is_archived = 1 AND m.is_deleted = 0',
  trash: 'm.is_deleted = 1',
  all: 'm.is_deleted = 0',
};

export function isWebMailboxFolder(value: string): value is WebMailboxFolder {
  return WEB_MAILBOX_FOLDERS.some((folder) => folder === value);
}

export async function listWebMessages(
  db: D1Database,
  mailboxIdInput: string,
  query: WebMessageListQuery,
): Promise<WebMessagePage> {
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const limit = normalizeLimit(query.limit);
  validateCursor(query.cursor);
  const conditions = [FOLDER_WHERE[query.folder]];
  const params: Array<string | number> = [mailboxId];
  appendSearchConditions(conditions, params, query.filters);
  if (query.cursor !== null) {
    conditions.push('(m.received_at < ? OR (m.received_at = ? AND m.id < ?))');
    params.push(query.cursor.before, query.cursor.before, query.cursor.beforeId);
  }
  const result = await db.prepare(`
    SELECT m.id, m.mailbox_id, m.direction, m.status, m.subject, m.sender, m.recipients,
      m.received_at, m.text_preview, m.raw_size, m.attachment_count,
      m.is_read, m.is_starred, m.is_archived, m.is_deleted
    FROM messages AS m
    WHERE m.mailbox_id = ? AND ${conditions.join(' AND ')}
    ORDER BY m.received_at DESC, m.id DESC
    LIMIT ?
  `).bind(...params, limit + 1).all<WebMessageRow>();
  const pageRows = result.results.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    messages: pageRows.map(toWebMessageSummary),
    nextCursor: result.results.length > limit && last !== undefined
      ? { before: last.received_at, beforeId: last.id }
      : null,
  };
}

function appendSearchConditions(
  conditions: string[],
  params: Array<string | number>,
  filters: WebMessageSearchFilters,
): void {
  for (const token of searchTokens(filters.query)) {
    conditions.push(`EXISTS (
      SELECT 1 FROM message_search_documents AS sd
      WHERE sd.message_id = m.id AND sd.mailbox_id = m.mailbox_id
        AND sd.search_text LIKE ? ESCAPE '^'
    )`);
    params.push(likePattern(token));
  }
  if (filters.from !== '') {
    conditions.push("m.sender LIKE ? ESCAPE '^'");
    params.push(likePattern(filters.from));
  }
  if (filters.to !== '') {
    conditions.push(`(
      m.recipients LIKE ? ESCAPE '^' OR m.cc LIKE ? ESCAPE '^'
      OR EXISTS (
        SELECT 1 FROM outbound_recipients AS recipient
        WHERE recipient.message_id = m.id AND recipient.address LIKE ? ESCAPE '^'
      )
    )`);
    const pattern = likePattern(filters.to);
    params.push(pattern, pattern, pattern);
  }
  if (filters.domain !== '') {
    conditions.push(`EXISTS (
      SELECT 1 FROM message_search_documents AS sd
      WHERE sd.message_id = m.id AND sd.search_text LIKE ? ESCAPE '^'
    )`);
    params.push(likePattern(`@${filters.domain}`));
  }
  if (filters.dateFrom !== null) {
    conditions.push('m.received_at >= ?');
    params.push(filters.dateFrom);
  }
  if (filters.dateToExclusive !== null) {
    conditions.push('m.received_at < ?');
    params.push(filters.dateToExclusive);
  }
  if (filters.attachment === 'with') conditions.push('m.attachment_count > 0');
  if (filters.attachment === 'without') conditions.push('m.attachment_count = 0');
  if (filters.read === 'read') conditions.push('m.is_read = 1');
  if (filters.read === 'unread') conditions.push('m.is_read = 0');
  if (filters.starred === 'starred') conditions.push('m.is_starred = 1');
  if (filters.starred === 'unstarred') conditions.push('m.is_starred = 0');
  if (filters.minimumBytes !== null) {
    conditions.push('m.raw_size >= ?');
    params.push(filters.minimumBytes);
  }
  if (filters.maximumBytes !== null) {
    conditions.push('m.raw_size <= ?');
    params.push(filters.maximumBytes);
  }
  appendQuickFilter(conditions, params, filters);
}

function appendQuickFilter(
  conditions: string[],
  params: Array<string | number>,
  filters: WebMessageSearchFilters,
): void {
  if (filters.quickFilter === 'unread') conditions.push('m.is_read = 0');
  if (filters.quickFilter === 'read') conditions.push('m.is_read = 1');
  if (filters.quickFilter === 'starred') conditions.push('m.is_starred = 1');
  if (filters.quickFilter === 'attachments') conditions.push('m.attachment_count > 0');
  if (filters.quickFilter === 'large') conditions.push('m.raw_size >= 1048576');
  if (filters.quickFilter === 'html') conditions.push('m.body_html_key IS NOT NULL');
  if (filters.quickFilter === 'bodyless') {
    conditions.push("(m.body_text_key IS NULL OR m.text_preview = '')");
  }
  if (filters.quickFilter === 'today') {
    conditions.push('m.received_at >= ?');
    params.push(filters.todayStart);
  }
  if (filters.quickFilter === 'last7d') {
    conditions.push('m.received_at >= ?');
    params.push(filters.sevenDaysAgo);
  }
}

function searchTokens(value: string): string[] {
  return [...new Set(value.trim().toLowerCase().split(/\s+/u).filter(Boolean))].slice(0, 8);
}

function likePattern(value: string): string {
  return `%${value.trim().toLowerCase().replace(/[\^%_]/gu, (match) => `^${match}`)}%`;
}

function normalizeLimit(value: number): number {
  if (!Number.isSafeInteger(value)) return 30;
  return Math.min(50, Math.max(1, value));
}

function validateCursor(cursor: WebMessageCursor | null): void {
  if (cursor === null) return;
  if (!Number.isSafeInteger(cursor.before) || cursor.before <= 0) {
    throw new DatabaseInputError('cursor.before', 'must be a positive timestamp');
  }
  normalizeId(cursor.beforeId, 'beforeId');
}
