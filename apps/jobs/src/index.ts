import {
  INBOUND_DEAD_LETTER_QUEUE_NAME,
  INBOUND_QUEUE_NAME,
  OUTBOUND_DEAD_LETTER_QUEUE_NAME,
  OUTBOUND_QUEUE_NAME,
} from '@cf-webmail/contracts';
import { handleDeadLetterBatch } from './dead-letter-consumer.js';
import { recoverRequestedDeadLetters } from './dead-letter-recovery.js';
import { handleInboundBatch } from './inbound-consumer.js';
import { recoverInboundHandoffs } from './inbound-recovery.js';
import { handleOutboundBatch } from './outbound-consumer.js';
import { recoverOutboundDeliveries } from './outbound-recovery.js';
import { reconcileInboundStaging } from './staging-reconciliation.js';
import { auditCanonicalStorage } from './storage-audit.js';

type JobsEnv = {
  DB: D1Database;
  RAW_EMAILS: R2Bucket;
  EMAIL?: SendEmail;
  INBOUND_QUEUE?: Queue<unknown>;
  OUTBOUND_QUEUE?: Queue<unknown>;
};

export default {
  async queue(batch: MessageBatch<unknown>, env: JobsEnv): Promise<void> {
    if (
      batch.queue === INBOUND_DEAD_LETTER_QUEUE_NAME
      || batch.queue === OUTBOUND_DEAD_LETTER_QUEUE_NAME
    ) {
      await handleDeadLetterBatch(batch.queue, batch.messages, env.DB, Date.now());
      return;
    }
    if (batch.queue === INBOUND_QUEUE_NAME) {
      await handleInboundBatch(batch.messages, {
        db: env.DB,
        rawEmails: env.RAW_EMAILS,
        now: Date.now,
      });
      return;
    }
    if (batch.queue === OUTBOUND_QUEUE_NAME) {
      if (env.EMAIL === undefined) {
        batch.retryAll({ delaySeconds: 60 });
        return;
      }
      await handleOutboundBatch(batch.messages, {
        db: env.DB,
        rawEmails: env.RAW_EMAILS,
        email: env.EMAIL,
        now: Date.now,
      });
      return;
    }
    batch.retryAll({ delaySeconds: 0 });
  },

  async scheduled(_controller: ScheduledController, env: JobsEnv): Promise<void> {
    if (env.INBOUND_QUEUE === undefined || env.OUTBOUND_QUEUE === undefined) {
      throw new Error('INBOUND_QUEUE and OUTBOUND_QUEUE bindings are required');
    }
    const now = Date.now();
    const [inbound, deadLetters, outbound, staging, storage] = await Promise.allSettled([
      recoverInboundHandoffs(env.DB, env.INBOUND_QUEUE, now),
      recoverRequestedDeadLetters(env.DB, env.INBOUND_QUEUE, env.OUTBOUND_QUEUE, now),
      recoverOutboundDeliveries(env.DB, env.OUTBOUND_QUEUE, now),
      reconcileInboundStaging(env.DB, env.RAW_EMAILS, env.INBOUND_QUEUE, now),
      auditCanonicalStorage(env.DB, env.RAW_EMAILS, now),
    ]);
    logRecovery('inbound_handoff', inbound);
    logRecovery('dead_letter', deadLetters);
    logRecovery('outbound', outbound);
    logRecovery('staging', staging);
    logRecovery('storage_audit', storage);
  },
} satisfies ExportedHandler<JobsEnv>;

function logRecovery(name: string, result: PromiseSettledResult<unknown>): void {
  if (result.status === 'fulfilled') {
    console.log(JSON.stringify({ event: `${name}.recovery_completed`, result: result.value }));
    return;
  }
  console.error(JSON.stringify({
    event: `${name}.recovery_failed`,
    errorType: result.reason instanceof Error ? result.reason.name : typeof result.reason,
  }));
}
