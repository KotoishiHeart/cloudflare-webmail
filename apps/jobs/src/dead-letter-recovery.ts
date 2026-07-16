import {
  parseInboundQueueMessage,
  parseOutboundQueueMessage,
} from '@cf-webmail/contracts';
import {
  listRequestedDeadLetters,
  markDeadLetterRequeued,
  recordDeadLetterRetryError,
} from '@cf-webmail/database';

export type DeadLetterRecoveryResult = {
  requeued: number;
  failed: number;
};

export async function recoverRequestedDeadLetters(
  db: D1Database,
  inboundQueue: Queue<unknown>,
  outboundQueue: Queue<unknown>,
  now: number,
): Promise<DeadLetterRecoveryResult> {
  const requested = await listRequestedDeadLetters(db, 25);
  const result: DeadLetterRecoveryResult = { requeued: 0, failed: 0 };
  for (const deadLetter of requested) {
    const parsed = deadLetter.source === 'inbound'
      ? parseInboundQueueMessage(deadLetter.payload)
      : parseOutboundQueueMessage(deadLetter.payload);
    if (!parsed.ok) {
      await recordDeadLetterRetryError(
        db,
        deadLetter.id,
        new Error(`saved Queue contract is invalid: ${parsed.issues.join(', ')}`),
      );
      result.failed += 1;
      continue;
    }
    try {
      const queue = deadLetter.source === 'inbound' ? inboundQueue : outboundQueue;
      await queue.send(parsed.value, { contentType: 'json' });
      await markDeadLetterRequeued(db, deadLetter.id, now);
      result.requeued += 1;
    } catch (error) {
      await recordDeadLetterRetryError(db, deadLetter.id, error);
      result.failed += 1;
    }
  }
  return result;
}
