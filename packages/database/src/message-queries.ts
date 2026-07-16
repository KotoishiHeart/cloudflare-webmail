import type { StoredInboundMessage } from './message-domain.js';
import { normalizeEmailAddress, normalizeId } from './validation.js';

type StoredInboundRow = {
  id: string;
  mailbox_id: string;
  raw_key: string;
  raw_sha256: string;
  status: string;
};

export async function activeMailboxOwnsPrimaryAddress(
  db: D1Database,
  mailboxIdInput: string,
  addressInput: string,
): Promise<boolean> {
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const address = normalizeEmailAddress(addressInput, 'accountEmail');
  const row = await db.prepare(`
    SELECT 1 AS present
    FROM mailboxes AS m
    JOIN mailbox_addresses AS ma
      ON ma.mailbox_id = m.id AND ma.kind = 'primary'
    WHERE m.id = ?
      AND m.status = 'active'
      AND ma.status = 'active'
      AND ma.address = ? COLLATE NOCASE
    LIMIT 1
  `).bind(mailboxId, address).first<{ present: number }>();
  return row !== null;
}

export async function findInboundMessageById(
  db: D1Database,
  messageIdInput: string,
): Promise<StoredInboundMessage | null> {
  const messageId = normalizeId(messageIdInput, 'messageId');
  const row = await db.prepare(`${BASE_MESSAGE_SELECT} WHERE id = ? LIMIT 1`)
    .bind(messageId)
    .first<StoredInboundRow>();
  return row === null ? null : toStoredMessage(row);
}

export async function findInboundMessageByContent(
  db: D1Database,
  mailboxIdInput: string,
  rawSha256: string,
): Promise<StoredInboundMessage | null> {
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  requireSha256(rawSha256);
  const row = await db.prepare(`
    ${BASE_MESSAGE_SELECT}
    WHERE mailbox_id = ? AND raw_sha256 = ?
    LIMIT 1
  `).bind(mailboxId, rawSha256).first<StoredInboundRow>();
  return row === null ? null : toStoredMessage(row);
}

export function requireSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('rawSha256 must be lowercase SHA-256');
}

const BASE_MESSAGE_SELECT = `
  SELECT id, mailbox_id, raw_key, raw_sha256, status
  FROM messages
`;

function toStoredMessage(row: StoredInboundRow): StoredInboundMessage {
  if (row.status !== 'ready' && row.status !== 'quarantined') {
    throw new Error('D1 returned an unsupported inbound message status');
  }
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    rawKey: row.raw_key,
    rawSha256: row.raw_sha256,
    status: row.status,
  };
}
