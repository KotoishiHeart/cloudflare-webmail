import type { MailboxLabel, MailboxLabelRow } from './mailbox-labels.js';
import { toMailboxLabel } from './mailbox-labels.js';
import { DatabaseInputError, normalizeId, requireTimestamp } from './validation.js';

export async function listMessageLabels(
  db: D1Database,
  mailboxIdInput: string,
  messageIdInput: string,
): Promise<MailboxLabel[]> {
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const messageId = normalizeId(messageIdInput, 'messageId');
  const result = await db.prepare(`
    SELECT l.id, l.mailbox_id, l.name, l.color, l.description,
      0 AS message_count, l.created_at, l.updated_at
    FROM message_labels AS ml
    JOIN mailbox_labels AS l
      ON l.id = ml.label_id AND l.mailbox_id = ml.mailbox_id
    WHERE ml.message_id = ? AND ml.mailbox_id = ?
    ORDER BY l.name COLLATE NOCASE, l.id
  `).bind(messageId, mailboxId).all<MailboxLabelRow>();
  return result.results.map(toMailboxLabel);
}

export async function replaceMessageLabels(
  db: D1Database,
  input: {
    mailboxId: string;
    messageId: string;
    userId: string;
    labelIds: string[];
    now: number;
  },
): Promise<MailboxLabel[]> {
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  const messageId = normalizeId(input.messageId, 'messageId');
  const userId = normalizeId(input.userId, 'userId');
  const now = requireTimestamp(input.now);
  const labelIds = [...new Set(input.labelIds.map((id) => normalizeId(id, 'labelId')))];
  if (labelIds.length > 20) {
    throw new DatabaseInputError('labelIds', 'must contain at most 20 labels');
  }
  await requireMailboxLabels(db, mailboxId, labelIds);
  await db.batch([
    db.prepare(`
      DELETE FROM message_labels WHERE message_id = ? AND mailbox_id = ?
        AND source_rule_id IS NULL
    `).bind(messageId, mailboxId),
    ...labelIds.map((labelId) => db.prepare(`
      INSERT INTO message_labels (
        message_id, mailbox_id, label_id, source_rule_id, applied_by_user_id, created_at
      ) VALUES (?, ?, ?, NULL, ?, ?)
      ON CONFLICT(message_id, label_id) DO UPDATE SET
        applied_by_user_id = excluded.applied_by_user_id
    `).bind(messageId, mailboxId, labelId, userId, now)),
  ]);
  return listMessageLabels(db, mailboxId, messageId);
}

export async function listLabelsForMessages(
  db: D1Database,
  mailboxIdInput: string,
  messageIdsInput: string[],
): Promise<Record<string, MailboxLabel[]>> {
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const messageIds = [...new Set(messageIdsInput.map((id) => normalizeId(id, 'messageId')))];
  const labels: Record<string, MailboxLabel[]> = Object.fromEntries(
    messageIds.map((messageId) => [messageId, []]),
  );
  if (messageIds.length === 0) return labels;
  const placeholders = messageIds.map(() => '?').join(', ');
  const result = await db.prepare(`
    SELECT ml.message_id, l.id, l.mailbox_id, l.name, l.color, l.description,
      0 AS message_count, l.created_at, l.updated_at
    FROM message_labels AS ml
    JOIN mailbox_labels AS l
      ON l.id = ml.label_id AND l.mailbox_id = ml.mailbox_id
    WHERE ml.mailbox_id = ? AND ml.message_id IN (${placeholders})
    ORDER BY l.name COLLATE NOCASE, l.id
  `).bind(mailboxId, ...messageIds).all<MailboxLabelRow & { message_id: string }>();
  for (const row of result.results) labels[row.message_id]?.push(toMailboxLabel(row));
  return labels;
}

async function requireMailboxLabels(
  db: D1Database,
  mailboxId: string,
  labelIds: string[],
): Promise<void> {
  if (labelIds.length === 0) return;
  const placeholders = labelIds.map(() => '?').join(', ');
  const row = await db.prepare(`
    SELECT COUNT(*) AS count FROM mailbox_labels
    WHERE mailbox_id = ? AND id IN (${placeholders})
  `).bind(mailboxId, ...labelIds).first<{ count: number }>();
  if (Number(row?.count ?? 0) !== labelIds.length) {
    throw new DatabaseInputError('labelIds', 'contains a label from another mailbox');
  }
}
