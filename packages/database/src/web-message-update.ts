import { normalizeId, requireTimestamp } from './validation.js';
import type { WebMessageFlagPatch } from './web-message-domain.js';

export async function updateWebMessageFlags(
  db: D1Database,
  messageIdInput: string,
  mailboxIdInput: string,
  patch: WebMessageFlagPatch,
  nowInput: number,
): Promise<void> {
  const messageId = normalizeId(messageIdInput, 'messageId');
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const now = requireTimestamp(nowInput);
  const assignments: string[] = [];
  const values: Array<number | null> = [];
  addFlag(assignments, values, 'is_read', patch.isRead);
  addFlag(assignments, values, 'is_starred', patch.isStarred);
  addFlag(assignments, values, 'is_archived', patch.isArchived);
  addFlag(assignments, values, 'is_deleted', patch.isDeleted);
  if (patch.isDeleted !== undefined) {
    assignments.push('deleted_at = ?');
    values.push(patch.isDeleted ? now : null);
  }
  if (assignments.length === 0) throw new Error('at least one message flag is required');

  await db.prepare(`
    UPDATE messages
    SET ${assignments.join(', ')}, updated_at = ?
    WHERE id = ? AND mailbox_id = ?
  `).bind(...values, now, messageId, mailboxId).run();
}

function addFlag(
  assignments: string[],
  values: Array<number | null>,
  column: string,
  value: boolean | undefined,
): void {
  if (value === undefined) return;
  assignments.push(`${column} = ?`);
  values.push(value ? 1 : 0);
}
