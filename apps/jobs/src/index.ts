import type { InboundQueueMessage } from '@cf-webmail/contracts';
import { deferUnimplementedInbound } from './inbound-consumer.js';

export default {
  queue(batch: MessageBatch<InboundQueueMessage>): void {
    deferUnimplementedInbound(batch.messages);
  },
} satisfies ExportedHandler<Env, InboundQueueMessage>;
