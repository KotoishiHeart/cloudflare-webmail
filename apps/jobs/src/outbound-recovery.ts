import { createOutboundQueueMessage } from '@cf-webmail/contracts';
import {
  listRecoverableOutboundMessages,
  markOutboundEnqueued,
} from '@cf-webmail/database';

const REENQUEUE_AFTER_MILLISECONDS = 5 * 60 * 1000;

export async function recoverOutboundDeliveries(
  db: D1Database,
  queue: Queue<unknown>,
  now: number,
): Promise<number> {
  const messages = await listRecoverableOutboundMessages(
    db,
    now,
    now - REENQUEUE_AFTER_MILLISECONDS,
    100,
  );
  if (messages.length === 0) return 0;
  await queue.sendBatch(messages.map((message) => ({
    body: createOutboundQueueMessage(message.messageId, message.mailboxId),
    contentType: 'json' as const,
  })));
  await markOutboundEnqueued(db, messages.map((message) => message.messageId), now);
  return messages.length;
}
