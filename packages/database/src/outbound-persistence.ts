import { isMailboxRole } from './domain.js';
import type {
  OutboundComposeContext,
  OutboundIdentity,
  OutboundMessageRecord,
  PersistOutboundResult,
  StoredOutboundRequest,
} from './outbound-domain.js';
import {
  normalizeId,
  normalizeIssuer,
  normalizeSubject,
} from './validation.js';
import { prepareOutboundAttachmentInserts } from './outbound-attachments.js';
import {
  prepareCompositionInsert,
  prepareDeliveryInsert,
  prepareOutboundMessageInsert,
  prepareRecipientInsert,
  recipientsOfKind,
  validateOutboundRecord,
} from './outbound-record-statements.js';

type ComposeContextRow = {
  user_id: string;
  mailbox_id: string;
  role: string;
  address: string;
  display_name: string;
};

type StoredOutboundRow = {
  message_id: string;
  mailbox_id: string;
  status: string;
  idempotency_key: string;
  provider_message_id: string;
  created_at: number;
};

export async function getOutboundComposeContext(
  db: D1Database,
  identity: OutboundIdentity,
  mailboxIdInput: string,
): Promise<OutboundComposeContext | null> {
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const issuer = normalizeIssuer(identity.issuer);
  const subject = normalizeSubject(identity.subject);
  const row = await db.prepare(`
    SELECT u.id AS user_id, m.id AS mailbox_id, mm.role,
      ma.address, m.display_name
    FROM access_identities AS ai
    JOIN users AS u ON u.id = ai.user_id AND u.status = 'active'
    JOIN mailbox_memberships AS mm ON mm.user_id = u.id
    JOIN mailboxes AS m
      ON m.id = mm.mailbox_id AND m.id = ? AND m.status = 'active'
    JOIN mailbox_addresses AS ma
      ON ma.mailbox_id = m.id
      AND ma.kind = 'primary'
      AND ma.status = 'active'
    WHERE ai.issuer = ? AND ai.subject = ?
    LIMIT 1
  `).bind(mailboxId, issuer, subject).first<ComposeContextRow>();
  if (row === null || !isMailboxRole(row.role)) {
    return null;
  }
  return {
    userId: row.user_id,
    mailboxId: row.mailbox_id,
    role: row.role,
    address: row.address,
    displayName: row.display_name,
  };
}

export async function findOutboundByIdempotency(
  db: D1Database,
  mailboxIdInput: string,
  idempotencyKeyInput: string,
): Promise<StoredOutboundRequest | null> {
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyInput);
  const row = await db.prepare(`
    ${STORED_OUTBOUND_SELECT}
    WHERE mailbox_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(mailboxId, idempotencyKey).first<StoredOutboundRow>();
  return row === null ? null : toStoredOutbound(row);
}

export async function persistOutboundMessage(
  db: D1Database,
  record: OutboundMessageRecord,
): Promise<PersistOutboundResult> {
  validateOutboundRecord(record);
  const existing = await findOutboundByIdempotency(
    db,
    record.mailboxId,
    record.idempotencyKey,
  );
  if (existing !== null) return { request: existing, created: false };

  const to = recipientsOfKind(record.recipients, 'to');
  const cc = recipientsOfKind(record.recipients, 'cc');
  const statements = [prepareOutboundMessageInsert(db, record, to, cc)];
  for (const recipient of record.recipients) {
    statements.push(prepareRecipientInsert(db, record.id, recipient));
  }
  statements.push(...prepareOutboundAttachmentInserts(db, record.id, record.attachments));
  statements.push(prepareCompositionInsert(db, record));
  statements.push(prepareDeliveryInsert(db, record));

  try {
    await db.batch(statements);
  } catch (error) {
    const raced = await findOutboundByIdempotency(
      db,
      record.mailboxId,
      record.idempotencyKey,
    );
    if (raced !== null) return { request: raced, created: false };
    throw error;
  }

  const created = await findOutboundByIdempotency(
    db,
    record.mailboxId,
    record.idempotencyKey,
  );
  if (created === null || created.messageId !== record.id) {
    throw new Error('outbound batch completed without the expected delivery record');
  }
  return { request: created, created: true };
}

export function normalizeIdempotencyKey(value: string): string {
  return normalizeId(value, 'Idempotency-Key');
}

const STORED_OUTBOUND_SELECT = `
  SELECT message_id, mailbox_id, status, idempotency_key,
    provider_message_id, created_at
  FROM outbound_deliveries
`;

function toStoredOutbound(row: StoredOutboundRow): StoredOutboundRequest {
  if (!['queued', 'sending', 'sent', 'failed'].includes(row.status)) {
    throw new Error('D1 returned an unsupported outbound delivery status');
  }
  return {
    messageId: row.message_id,
    mailboxId: row.mailbox_id,
    status: row.status as StoredOutboundRequest['status'],
    idempotencyKey: row.idempotency_key,
    providerMessageId: row.provider_message_id,
    createdAt: row.created_at,
  };
}
