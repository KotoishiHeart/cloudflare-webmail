import {
  INBOUND_DEAD_LETTER_QUEUE_NAME,
  OUTBOUND_DEAD_LETTER_QUEUE_NAME,
  parseInboundQueueMessage,
  parseOutboundQueueMessage,
} from '@cf-webmail/contracts';
import {
  markInboundHandoffDeadLetter,
  saveQueueDeadLetter,
  type DeadLetterSource,
} from '@cf-webmail/database';

export type DeadLetterQueueItem = Pick<
  Message<unknown>,
  'id' | 'body' | 'attempts' | 'ack' | 'retry'
>;

export type DeadLetterBatchResult = {
  acknowledged: number;
  retried: number;
  invalid: number;
};

export async function handleDeadLetterBatch(
  queueName: string,
  messages: readonly DeadLetterQueueItem[],
  db: D1Database,
  now: number,
): Promise<DeadLetterBatchResult> {
  const source = sourceForQueue(queueName);
  const result: DeadLetterBatchResult = { acknowledged: 0, retried: 0, invalid: 0 };
  for (const message of messages) {
    try {
      const serialized = serializeBody(message.body);
      const parsed = source === 'inbound'
        ? parseInboundQueueMessage(message.body)
        : parseOutboundQueueMessage(message.body);
      const payloadValid = serialized.exact && parsed.ok;
      const identity = parsed.ok
        ? { messageId: parsed.value.messageId, mailboxId: parsed.value.mailboxId }
        : { messageId: null, mailboxId: null };
      const payloadSha256 = await sha256(serialized.json);
      const id = await sha256(`${source}\n${serialized.json}`);
      await saveQueueDeadLetter(db, {
        id,
        source,
        deadLetterQueue: queueName,
        sourceMessageId: message.id,
        ...identity,
        payloadJson: serialized.json,
        payloadSha256,
        payloadValid,
      }, now);
      if (source === 'inbound' && identity.messageId !== null) {
        await bestEffortMarkInboundDeadLetter(db, identity.messageId, now);
      }
      message.ack();
      result.acknowledged += 1;
      if (!payloadValid) result.invalid += 1;
    } catch (error) {
      console.error(JSON.stringify({
        event: 'dead_letter.persistence_failed',
        queue: queueName,
        sourceMessageId: message.id,
        errorType: error instanceof Error ? error.name : typeof error,
      }));
      message.retry({ delaySeconds: retryDelay(message.attempts) });
      result.retried += 1;
    }
  }
  return result;
}

function sourceForQueue(queueName: string): DeadLetterSource {
  if (queueName === INBOUND_DEAD_LETTER_QUEUE_NAME) return 'inbound';
  if (queueName === OUTBOUND_DEAD_LETTER_QUEUE_NAME) return 'outbound';
  throw new Error(`unsupported dead-letter queue: ${queueName}`);
}

function serializeBody(body: unknown): { json: string; exact: boolean } {
  try {
    const json = JSON.stringify(body);
    if (json === undefined || json.length > 131072) {
      return { json: JSON.stringify({ error: 'unserializable_queue_payload' }), exact: false };
    }
    return { json, exact: true };
  } catch {
    return { json: JSON.stringify({ error: 'unserializable_queue_payload' }), exact: false };
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function bestEffortMarkInboundDeadLetter(
  db: D1Database,
  messageId: string,
  now: number,
): Promise<void> {
  try {
    await markInboundHandoffDeadLetter(db, messageId, now);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'dead_letter.handoff_mark_failed',
      messageId,
      errorType: error instanceof Error ? error.name : typeof error,
    }));
  }
}

function retryDelay(attempts: number): number {
  const exponent = Math.max(0, Math.min(7, Math.floor(attempts) - 1));
  return Math.min(30 * (2 ** exponent), 3600);
}
