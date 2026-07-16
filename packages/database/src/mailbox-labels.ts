import {
  DatabaseInputError,
  normalizeId,
  requireTimestamp,
} from './validation.js';

export type MailboxLabel = {
  id: string;
  mailboxId: string;
  name: string;
  color: string;
  description: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

export type MailboxLabelRow = {
  id: string;
  mailbox_id: string;
  name: string;
  color: string;
  description: string;
  message_count: number;
  created_at: number;
  updated_at: number;
};

export async function listMailboxLabels(
  db: D1Database,
  mailboxIdInput: string,
): Promise<MailboxLabel[]> {
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const result = await db.prepare(`
    SELECT l.id, l.mailbox_id, l.name, l.color, l.description,
      COUNT(ml.message_id) AS message_count, l.created_at, l.updated_at
    FROM mailbox_labels AS l
    LEFT JOIN message_labels AS ml
      ON ml.label_id = l.id AND ml.mailbox_id = l.mailbox_id
    WHERE l.mailbox_id = ?
    GROUP BY l.id
    ORDER BY l.name COLLATE NOCASE, l.id
  `).bind(mailboxId).all<MailboxLabelRow>();
  return result.results.map(toMailboxLabel);
}

export async function createMailboxLabel(
  db: D1Database,
  input: {
    id: string;
    mailboxId: string;
    userId: string;
    name: string;
    color: string;
    description: string;
    now: number;
  },
): Promise<MailboxLabel> {
  const values = normalizedLabelInput(input);
  const result = await db.prepare(`
    INSERT INTO mailbox_labels (
      id, mailbox_id, name, color, description,
      created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mailbox_id, name) DO NOTHING
  `).bind(
    values.id,
    values.mailboxId,
    values.name,
    values.color,
    values.description,
    values.userId,
    values.now,
    values.now,
  ).run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new DatabaseInputError('name', 'already exists in this mailbox');
  }
  return {
    id: values.id,
    mailboxId: values.mailboxId,
    name: values.name,
    color: values.color,
    description: values.description,
    messageCount: 0,
    createdAt: values.now,
    updatedAt: values.now,
  };
}

export async function getMailboxLabel(
  db: D1Database,
  mailboxIdInput: string,
  labelIdInput: string,
): Promise<MailboxLabel | null> {
  const row = await db.prepare(`
    SELECT l.id, l.mailbox_id, l.name, l.color, l.description,
      COUNT(ml.message_id) AS message_count, l.created_at, l.updated_at
    FROM mailbox_labels AS l
    LEFT JOIN message_labels AS ml
      ON ml.label_id = l.id AND ml.mailbox_id = l.mailbox_id
    WHERE l.mailbox_id = ? AND l.id = ?
    GROUP BY l.id
  `).bind(
    normalizeId(mailboxIdInput, 'mailboxId'),
    normalizeId(labelIdInput, 'labelId'),
  ).first<MailboxLabelRow>();
  return row === null ? null : toMailboxLabel(row);
}

export async function updateMailboxLabel(
  db: D1Database,
  input: {
    id: string;
    mailboxId: string;
    name: string;
    color: string;
    description: string;
    now: number;
  },
): Promise<boolean> {
  const id = normalizeId(input.id, 'labelId');
  const mailboxId = normalizeId(input.mailboxId, 'mailboxId');
  const now = requireTimestamp(input.now);
  const name = normalizeLabelName(input.name);
  const conflict = await db.prepare(`
    SELECT 1 AS found FROM mailbox_labels
    WHERE mailbox_id = ? AND name = ? COLLATE NOCASE AND id <> ?
    LIMIT 1
  `).bind(mailboxId, name, id).first<{ found: number }>();
  if (conflict !== null) {
    throw new DatabaseInputError('name', 'already exists in this mailbox');
  }
  const result = await db.prepare(`
    UPDATE mailbox_labels
    SET name = ?, color = ?, description = ?, updated_at = ?
    WHERE id = ? AND mailbox_id = ?
  `).bind(
    name,
    normalizeLabelColor(input.color),
    normalizeDescription(input.description),
    now,
    id,
    mailboxId,
  ).run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function deleteMailboxLabel(
  db: D1Database,
  mailboxIdInput: string,
  labelIdInput: string,
): Promise<boolean> {
  const result = await db.prepare(`
    DELETE FROM mailbox_labels WHERE id = ? AND mailbox_id = ?
  `).bind(
    normalizeId(labelIdInput, 'labelId'),
    normalizeId(mailboxIdInput, 'mailboxId'),
  ).run();
  return Number(result.meta.changes ?? 0) === 1;
}

export function toMailboxLabel(row: MailboxLabelRow): MailboxLabel {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    name: row.name,
    color: row.color,
    description: row.description,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizedLabelInput(input: {
  id: string;
  mailboxId: string;
  userId: string;
  name: string;
  color: string;
  description: string;
  now: number;
}) {
  return {
    id: normalizeId(input.id, 'labelId'),
    mailboxId: normalizeId(input.mailboxId, 'mailboxId'),
    userId: normalizeId(input.userId, 'userId'),
    name: normalizeLabelName(input.name),
    color: normalizeLabelColor(input.color),
    description: normalizeDescription(input.description),
    now: requireTimestamp(input.now),
  };
}

function normalizeLabelName(value: string): string {
  const name = value.trim().replace(/\s+/gu, ' ');
  if (name.length < 1 || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new DatabaseInputError('name', 'must contain 1 to 80 safe characters');
  }
  return name;
}

function normalizeLabelColor(value: string): string {
  if (!/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new DatabaseInputError('color', 'must be #RRGGBB');
  }
  return value.toLowerCase();
}

function normalizeDescription(value: string): string {
  const description = value.trim();
  if (description.length > 240 || /[\u0000-\u001f\u007f]/u.test(description)) {
    throw new DatabaseInputError('description', 'must not exceed 240 safe characters');
  }
  return description;
}
