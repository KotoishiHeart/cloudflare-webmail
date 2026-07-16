import { isMailboxRole } from './domain.js';
import type {
  OutboundComposeContext,
  OutboundIdentity,
  OutboundMessageRecord,
  OutboundRecipient,
  PersistOutboundResult,
  StoredOutboundRequest,
} from './outbound-domain.js';
import {
  DatabaseInputError,
  normalizeEmailAddress,
  normalizeId,
  normalizeIssuer,
  normalizeSubject,
  requireTimestamp,
} from './validation.js';
import { requireSha256 } from './message-queries.js';

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

function prepareOutboundMessageInsert(
  db: D1Database,
  record: OutboundMessageRecord,
  to: string[],
  cc: string[],
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO messages (
      id, mailbox_id, direction, status, processing_error,
      envelope_from, delivered_to, rfc_message_id, in_reply_to, references_header,
      subject, sender, recipients, cc, reply_to, date_header, received_at,
      text_preview, raw_key, raw_sha256, raw_etag, raw_size,
      body_text_key, body_html_key, attachment_count,
      is_read, created_at, updated_at
    ) VALUES (
      ?, ?, 'outbound', 'queued', '',
      ?, ?, ?, '', '',
      ?, ?, ?, ?, '', ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, 0,
      1, ?, ?
    )
  `).bind(
    record.id,
    record.mailboxId,
    record.senderAddress,
    record.senderAddress,
    record.archiveMessageId,
    record.subject,
    record.sender,
    to.join(', '),
    cc.join(', '),
    new Date(record.createdAt).toUTCString(),
    record.createdAt,
    record.textPreview,
    record.rawKey,
    record.rawSha256,
    record.rawEtag,
    record.rawSize,
    record.bodyTextKey,
    record.bodyHtmlKey,
    record.createdAt,
    record.createdAt,
  );
}

function prepareRecipientInsert(
  db: D1Database,
  messageId: string,
  recipient: OutboundRecipient,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO outbound_recipients (message_id, kind, ordinal, address)
    VALUES (?, ?, ?, ?)
  `).bind(messageId, recipient.kind, recipient.ordinal, recipient.address);
}

function prepareDeliveryInsert(
  db: D1Database,
  record: OutboundMessageRecord,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO outbound_deliveries (
      message_id, mailbox_id, idempotency_key, requested_by_user_id,
      sender_address, sender_name, status,
      enqueued_at, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
  `).bind(
    record.id,
    record.mailboxId,
    record.idempotencyKey,
    record.requestedByUserId,
    record.senderAddress,
    senderName(record.sender, record.senderAddress),
    record.createdAt,
    record.createdAt,
    record.createdAt,
    record.createdAt,
  );
}

function senderName(sender: string, address: string): string {
  const suffix = ` <${address}>`;
  return sender.endsWith(suffix) ? sender.slice(0, -suffix.length) : address;
}

function validateOutboundRecord(record: OutboundMessageRecord): void {
  normalizeId(record.id, 'messageId');
  normalizeId(record.mailboxId, 'mailboxId');
  normalizeId(record.requestedByUserId, 'requestedByUserId');
  normalizeIdempotencyKey(record.idempotencyKey);
  normalizeEmailAddress(record.senderAddress, 'senderAddress');
  requireSha256(record.rawSha256);
  requireTimestamp(record.createdAt, 'createdAt');
  if (record.rawSize < 0 || record.rawSize > 5 * 1024 * 1024) {
    throw new DatabaseInputError('rawSize', 'must not exceed 5 MiB');
  }
  if (record.recipients.length < 1 || record.recipients.length > 50) {
    throw new DatabaseInputError('recipients', 'must contain between 1 and 50 addresses');
  }
  for (const recipient of record.recipients) {
    normalizeEmailAddress(recipient.address, `${recipient.kind}[${recipient.ordinal}]`);
  }
}

function recipientsOfKind(
  recipients: OutboundRecipient[],
  kind: OutboundRecipient['kind'],
): string[] {
  return recipients.filter((recipient) => recipient.kind === kind).map((recipient) => recipient.address);
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
