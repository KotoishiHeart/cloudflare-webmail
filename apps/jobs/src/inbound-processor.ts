import type { InboundQueueMessage } from '@cf-webmail/contracts';
import {
  findInboundMessageByContent,
  findInboundMessageById,
  activeMailboxOwnsPrimaryAddress,
  persistInboundMessage,
} from '@cf-webmail/database';
import { PermanentInboundError, errorType } from './inbound-errors.js';
import { parseAndHashRawEmail } from './mime-parser.js';
import { prepareMessage, toMessageRecord } from './prepared-message.js';
import { storePreparedMessage } from './r2-message-store.js';
import { loadValidatedStagedRaw } from './staged-raw.js';

export type InboundProcessorDependencies = {
  db: D1Database;
  rawEmails: Pick<R2Bucket, 'get' | 'put' | 'delete'>;
  now(): number;
};

export type InboundProcessResult = {
  messageId: string;
  status: 'stored' | 'duplicate';
  stagingDeleted: boolean;
};

export async function processInboundQueueMessage(
  queueMessage: InboundQueueMessage,
  dependencies: InboundProcessorDependencies,
): Promise<InboundProcessResult> {
  const existingId = await findInboundMessageById(dependencies.db, queueMessage.messageId);
  if (existingId !== null) {
    if (existingId.mailboxId !== queueMessage.mailboxId) {
      throw new PermanentInboundError('message-id-collision', 'message ID belongs to another mailbox');
    }
    return duplicateResult(existingId.id, await deleteStaging(dependencies, queueMessage));
  }

  if (!await activeMailboxOwnsPrimaryAddress(
    dependencies.db,
    queueMessage.mailboxId,
    queueMessage.accountEmail,
  )) {
    throw new PermanentInboundError('mailbox-mismatch', 'mailbox and account address do not match');
  }

  const staged = await loadValidatedStagedRaw(dependencies.rawEmails, queueMessage);
  const parsed = await parseAndHashRawEmail(staged.body);
  if (parsed.parseErrorType !== null) {
    console.warn(JSON.stringify({
      event: 'inbound.mime_quarantined',
      messageId: queueMessage.messageId,
      errorType: parsed.parseErrorType,
    }));
  }

  const existingContent = await findInboundMessageByContent(
    dependencies.db,
    queueMessage.mailboxId,
    parsed.rawSha256,
  );
  if (existingContent !== null) {
    return duplicateResult(existingContent.id, await deleteStaging(dependencies, queueMessage));
  }

  const now = dependencies.now();
  const prepared = await prepareMessage(
    queueMessage,
    parsed.email,
    parsed.parseErrorType,
    now,
  );
  const stored = await storePreparedMessage(
    dependencies.rawEmails,
    queueMessage,
    prepared,
    parsed.rawSha256,
  );
  const result = await persistInboundMessage(dependencies.db, toMessageRecord(
    queueMessage,
    prepared,
    parsed.rawSha256,
    stored.rawEtag,
    now,
  ));
  const stagingDeleted = await deleteStaging(dependencies, queueMessage);
  console.log(JSON.stringify({
    event: result.created ? 'inbound.persisted' : 'inbound.duplicate',
    messageId: result.message.id,
    mailboxId: result.message.mailboxId,
    status: result.message.status,
  }));
  return {
    messageId: result.message.id,
    status: result.created ? 'stored' : 'duplicate',
    stagingDeleted,
  };
}

async function deleteStaging(
  dependencies: InboundProcessorDependencies,
  message: InboundQueueMessage,
): Promise<boolean> {
  try {
    await dependencies.rawEmails.delete(message.rawKey);
    return true;
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'inbound.staging_cleanup_failed',
      messageId: message.messageId,
      errorType: errorType(error),
    }));
    return false;
  }
}

function duplicateResult(messageId: string, stagingDeleted: boolean): InboundProcessResult {
  return { messageId, status: 'duplicate', stagingDeleted };
}
