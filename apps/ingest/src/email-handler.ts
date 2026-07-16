import {
  INBOUND_QUEUE_SCHEMA_VERSION,
  MAX_INBOUND_MESSAGE_BYTES,
  parseInboundQueueMessage,
  type InboundQueueMessage,
} from '@cf-webmail/contracts';
import { resolveActiveMailboxAddress, type MailboxRoute } from '@cf-webmail/database';
import { buildRawEmailKey, stageRawEmail } from './raw-staging.js';

export const UNKNOWN_RECIPIENT_REASON = 'Recipient mailbox is not configured';
export const INVALID_MESSAGE_REASON = 'Message cannot be accepted';
export const PROCESSING_FAILURE_REASON = 'Mailbox processing failed';

export type InboundEmail = Pick<
  ForwardableEmailMessage,
  'from' | 'to' | 'headers' | 'raw' | 'rawSize' | 'setReject'
>;

export type InboundDependencies = {
  db: D1Database;
  rawEmails: Pick<R2Bucket, 'put'>;
  enqueue(message: InboundQueueMessage): Promise<void>;
};

export type InboundReceipt = {
  messageId: string;
  receivedAt: number;
};

export type InboundResult =
  | { accepted: true; rawKey: string; queueMessage: InboundQueueMessage }
  | {
    accepted: false;
    code: 'invalid-size' | 'unknown-recipient' | 'routing-failed'
      | 'invalid-contract' | 'staging-failed' | 'queue-failed';
    reason: string;
    rawKey?: string;
  };

export async function handleInboundEmail(
  message: InboundEmail,
  dependencies: InboundDependencies,
  receipt: InboundReceipt,
): Promise<InboundResult> {
  if (!isValidRawSize(message.rawSize)) {
    return reject(message, 'invalid-size', INVALID_MESSAGE_REASON);
  }

  let route: MailboxRoute | null;
  try {
    route = await resolveActiveMailboxAddress(dependencies.db, message.to);
  } catch (error) {
    logFailure('inbound.routing_failed', receipt.messageId, error);
    return reject(message, 'routing-failed', PROCESSING_FAILURE_REASON);
  }
  if (route === null) {
    return reject(message, 'unknown-recipient', UNKNOWN_RECIPIENT_REASON);
  }

  const rawKey = buildRawEmailKey(receipt, route.mailboxId);
  const candidate = createQueueMessage(message, route, receipt, rawKey);
  const parsed = parseInboundQueueMessage(candidate);
  if (!parsed.ok) {
    console.error(JSON.stringify({
      event: 'inbound.contract_invalid',
      messageId: receipt.messageId,
      issues: parsed.issues,
    }));
    return reject(message, 'invalid-contract', INVALID_MESSAGE_REASON, rawKey);
  }

  try {
    await stageRawEmail(dependencies.rawEmails, message.raw, parsed.value, route.mailboxId);
  } catch (error) {
    logFailure('inbound.staging_failed', receipt.messageId, error);
    return reject(message, 'staging-failed', PROCESSING_FAILURE_REASON, rawKey);
  }

  try {
    await dependencies.enqueue(parsed.value);
  } catch (error) {
    // Keep the staged object: Queue delivery can be ambiguous after an exception.
    logFailure('inbound.queue_failed', receipt.messageId, error);
    return reject(message, 'queue-failed', PROCESSING_FAILURE_REASON, rawKey);
  }

  console.log(JSON.stringify({
    event: 'inbound.accepted',
    messageId: receipt.messageId,
    mailboxId: route.mailboxId,
    rawSize: message.rawSize,
  }));
  return { accepted: true, rawKey, queueMessage: parsed.value };
}

function createQueueMessage(
  message: InboundEmail,
  route: MailboxRoute,
  receipt: InboundReceipt,
  rawKey: string,
): InboundQueueMessage {
  return {
    schemaVersion: INBOUND_QUEUE_SCHEMA_VERSION,
    messageId: receipt.messageId,
    mailboxId: route.mailboxId,
    rawKey,
    envelope: { from: message.from, to: route.address },
    headers: {
      subject: (message.headers.get('subject') ?? '').slice(0, 240),
      messageId: (message.headers.get('message-id') ?? '').slice(0, 320),
    },
    receivedAt: receipt.receivedAt,
    accountEmail: route.primaryAddress,
    routing: { action: 'store', policy: 'active-mailbox-v1' },
    staging: { encoding: 'identity', rawSize: message.rawSize },
  };
}

function isValidRawSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_INBOUND_MESSAGE_BYTES;
}

function reject(
  message: InboundEmail,
  code: Exclude<InboundResult, { accepted: true }>['code'],
  reason: string,
  rawKey?: string,
): InboundResult {
  message.setReject(reason);
  return rawKey === undefined
    ? { accepted: false, code, reason }
    : { accepted: false, code, reason, rawKey };
}

function logFailure(event: string, messageId: string, error: unknown): void {
  console.error(JSON.stringify({
    event,
    messageId,
    errorType: error instanceof Error ? error.name : typeof error,
  }));
}
