import { normalizeId } from './validation.js';
import {
  WEB_MAILBOX_FOLDERS,
  type WebMailboxFolder,
  type WebMessageCursor,
  type WebMessagePage,
} from './web-message-domain.js';
import { toWebMessageSummary, type WebMessageRow } from './web-message-rows.js';

const FOLDER_WHERE: Record<WebMailboxFolder, string> = {
  inbox: "direction = 'inbound' AND is_archived = 0 AND is_deleted = 0",
  starred: 'is_starred = 1 AND is_deleted = 0',
  archive: 'is_archived = 1 AND is_deleted = 0',
  trash: 'is_deleted = 1',
  all: 'is_deleted = 0',
};

export function isWebMailboxFolder(value: string): value is WebMailboxFolder {
  return WEB_MAILBOX_FOLDERS.some((folder) => folder === value);
}

export async function listWebMessages(
  db: D1Database,
  mailboxIdInput: string,
  folder: WebMailboxFolder,
  limitInput: number,
  cursor: WebMessageCursor | null,
): Promise<WebMessagePage> {
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const limit = normalizeLimit(limitInput);
  validateCursor(cursor);
  const cursorSql = cursor === null
    ? ''
    : 'AND (received_at < ? OR (received_at = ? AND id < ?))';
  const cursorParams = cursor === null
    ? []
    : [cursor.before, cursor.before, cursor.beforeId];
  const result = await db.prepare(`
    SELECT id, mailbox_id, direction, status, subject, sender, recipients,
      received_at, text_preview, raw_size, attachment_count,
      is_read, is_starred, is_archived, is_deleted
    FROM messages
    WHERE mailbox_id = ? AND ${FOLDER_WHERE[folder]} ${cursorSql}
    ORDER BY received_at DESC, id DESC
    LIMIT ?
  `).bind(mailboxId, ...cursorParams, limit + 1).all<WebMessageRow>();
  const pageRows = result.results.slice(0, limit);
  const messages = pageRows.map(toWebMessageSummary);
  const last = pageRows.at(-1);
  return {
    messages,
    nextCursor: result.results.length > limit && last !== undefined
      ? { before: last.received_at, beforeId: last.id }
      : null,
  };
}

function normalizeLimit(value: number): number {
  if (!Number.isSafeInteger(value)) return 30;
  return Math.min(50, Math.max(1, value));
}

function validateCursor(cursor: WebMessageCursor | null): void {
  if (cursor === null) return;
  if (!Number.isSafeInteger(cursor.before) || cursor.before <= 0) {
    throw new Error('cursor before must be a positive timestamp');
  }
  normalizeId(cursor.beforeId, 'beforeId');
}
