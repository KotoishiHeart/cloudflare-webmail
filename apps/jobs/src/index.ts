import { handleInboundBatch } from './inbound-consumer.js';
import { OUTBOUND_QUEUE_NAME } from '@cf-webmail/contracts';
import { handleOutboundBatch } from './outbound-consumer.js';
import { recoverOutboundDeliveries } from './outbound-recovery.js';

const INBOUND_QUEUE_NAME = 'cf-webmail-inbound';

type JobsEnv = {
  DB: D1Database;
  RAW_EMAILS: R2Bucket;
  EMAIL?: SendEmail;
  OUTBOUND_QUEUE?: Queue<unknown>;
};

export default {
  async queue(batch: MessageBatch<unknown>, env: JobsEnv): Promise<void> {
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
    if (env.OUTBOUND_QUEUE === undefined) throw new Error('OUTBOUND_QUEUE binding is required');
    const recovered = await recoverOutboundDeliveries(env.DB, env.OUTBOUND_QUEUE, Date.now());
    console.log(JSON.stringify({ event: 'outbound.recovery_completed', recovered }));
  },
} satisfies ExportedHandler<JobsEnv>;
