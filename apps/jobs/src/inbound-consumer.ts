import { parseInboundQueueMessage } from '@cf-webmail/contracts';
import { PermanentInboundError, errorType } from './inbound-errors.js';
import {
  processInboundQueueMessage,
  type InboundProcessorDependencies,
} from './inbound-processor.js';

export type InboundQueueItem = Pick<
  Message<unknown>,
  'body' | 'attempts' | 'ack' | 'retry'
>;

export type InboundBatchResult = {
  acknowledged: number;
  retried: number;
  invalid: number;
};

export async function handleInboundBatch(
  messages: readonly InboundQueueItem[],
  dependencies: InboundProcessorDependencies,
): Promise<InboundBatchResult> {
  const result: InboundBatchResult = { acknowledged: 0, retried: 0, invalid: 0 };
  for (const message of messages) {
    const parsed = parseInboundQueueMessage(message.body);
    if (!parsed.ok) {
      console.error(JSON.stringify({
        event: 'inbound.contract_invalid',
        issues: parsed.issues,
      }));
      message.retry({ delaySeconds: 0 });
      result.invalid += 1;
      result.retried += 1;
      continue;
    }

    try {
      await processInboundQueueMessage(parsed.value, dependencies);
      message.ack();
      result.acknowledged += 1;
    } catch (error) {
      const permanent = error instanceof PermanentInboundError;
      const delaySeconds = permanent ? 0 : retryDelay(message.attempts);
      console.error(JSON.stringify({
        event: 'inbound.processing_failed',
        messageId: parsed.value.messageId,
        errorType: errorType(error),
        errorCode: permanent ? error.code : 'transient',
        attempt: message.attempts,
        retryDelaySeconds: delaySeconds,
      }));
      message.retry({ delaySeconds });
      result.retried += 1;
    }
  }
  return result;
}

function retryDelay(attempts: number): number {
  const exponent = Math.max(0, Math.min(7, Math.floor(attempts) - 1));
  return Math.min(30 * (2 ** exponent), 3600);
}
