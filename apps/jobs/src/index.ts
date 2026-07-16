import { handleInboundBatch } from './inbound-consumer.js';

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await handleInboundBatch(batch.messages, {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      now: Date.now,
    });
  },
} satisfies ExportedHandler<Env>;
