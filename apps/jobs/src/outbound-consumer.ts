import { parseOutboundQueueMessage } from '@cf-webmail/contracts';
import {
  PermanentOutboundError,
  RetryableOutboundError,
  outboundErrorType,
} from './outbound-errors.js';
import {
  processOutboundQueueMessage,
  type OutboundProcessorDependencies,
} from './outbound-processor.js';

export type OutboundQueueItem = Pick<
  Message<unknown>,
  'body' | 'attempts' | 'ack' | 'retry'
>;

export type OutboundBatchResult = {
  acknowledged: number;
  retried: number;
  invalid: number;
};

export async function handleOutboundBatch(
  messages: readonly OutboundQueueItem[],
  dependencies: OutboundProcessorDependencies,
): Promise<OutboundBatchResult> {
  const result: OutboundBatchResult = { acknowledged: 0, retried: 0, invalid: 0 };
  for (const message of messages) {
    const parsed = parseOutboundQueueMessage(message.body);
    if (!parsed.ok) {
      console.error(JSON.stringify({
        event: 'outbound.contract_invalid',
        issues: parsed.issues,
      }));
      message.retry({ delaySeconds: 0 });
      result.invalid += 1;
      result.retried += 1;
      continue;
    }
    try {
      await processOutboundQueueMessage(parsed.value, dependencies);
      message.ack();
      result.acknowledged += 1;
    } catch (error) {
      const permanent = error instanceof PermanentOutboundError;
      const delaySeconds = permanent ? 0 : retryDelay(message.attempts);
      console.error(JSON.stringify({
        event: 'outbound.processing_failed',
        messageId: parsed.value.messageId,
        errorType: outboundErrorType(error),
        errorCode: error instanceof PermanentOutboundError || error instanceof RetryableOutboundError
          ? error.code
          : 'retryable',
        attempt: message.attempts,
        retryDelaySeconds: delaySeconds,
      }));
      if (permanent) {
        message.ack();
        result.acknowledged += 1;
      } else {
        message.retry({ delaySeconds });
        result.retried += 1;
      }
    }
  }
  return result;
}

function retryDelay(attempts: number): number {
  const exponent = Math.max(0, Math.min(7, Math.floor(attempts) - 1));
  return Math.min(30 * (2 ** exponent), 3600);
}
