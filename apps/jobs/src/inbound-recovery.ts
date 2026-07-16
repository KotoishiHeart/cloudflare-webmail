import { parseInboundQueueMessage } from '@cf-webmail/contracts';
import {
  listRecoverableInboundHandoffs,
  markInboundHandoffEnqueued,
  markInboundHandoffQueueFailed,
} from '@cf-webmail/database';

const REENQUEUE_AFTER_MILLISECONDS = 5 * 60 * 1000;

export type InboundRecoveryResult = {
  requeued: number;
  failed: number;
};

export async function recoverInboundHandoffs(
  db: D1Database,
  queue: Queue<unknown>,
  now: number,
): Promise<InboundRecoveryResult> {
  const handoffs = await listRecoverableInboundHandoffs(
    db,
    now - REENQUEUE_AFTER_MILLISECONDS,
    100,
  );
  const result: InboundRecoveryResult = { requeued: 0, failed: 0 };
  for (const handoff of handoffs) {
    const parsed = parseInboundQueueMessage(handoff.payload);
    if (!parsed.ok) {
      await markInboundHandoffQueueFailed(
        db,
        handoff.messageId,
        new Error(`stored Queue contract is invalid: ${parsed.issues.join(', ')}`),
        now,
      );
      result.failed += 1;
      continue;
    }
    try {
      await queue.send(parsed.value, { contentType: 'json' });
      await markInboundHandoffEnqueued(db, handoff.messageId, now);
      result.requeued += 1;
    } catch (error) {
      await markInboundHandoffQueueFailed(db, handoff.messageId, error, now);
      result.failed += 1;
    }
  }
  return result;
}
