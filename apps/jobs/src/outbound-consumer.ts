import { parseOutboundQueueMessage } from '@cf-webmail/contracts';
import { recordDeliveryEventSafely, resolveDeadLettersForMessage } from '@cf-webmail/database';
import {
  PermanentOutboundError,
  RetryableOutboundError,
  outboundErrorType,
} from './outbound-errors.js';
import { isD1DailyLimitError, queueRetryDelay } from './queue-retry.js';
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
      await resolveDeadLettersForMessage(
        dependencies.db,
        'outbound',
        parsed.value.messageId,
        dependencies.now(),
      );
      message.ack();
      result.acknowledged += 1;
    } catch (error) {
      const permanent = error instanceof PermanentOutboundError;
      const dailyLimit = !permanent && isD1DailyLimitError(error);
      const delaySeconds = permanent ? 0 : queueRetryDelay(error, message.attempts, dependencies.now());
      const errorCode = dailyLimit
        ? 'd1_daily_limit'
        : error instanceof PermanentOutboundError || error instanceof RetryableOutboundError
          ? error.code
          : 'retryable';
      console.error(JSON.stringify({
        event: 'outbound.processing_failed',
        messageId: parsed.value.messageId,
        errorType: outboundErrorType(error),
        errorCode,
        attempt: message.attempts,
        retryDelaySeconds: delaySeconds,
      }));
      await recordDeliveryEventSafely(dependencies.db, {
        direction: 'outbound', stage: 'queue',
        status: permanent ? 'failed' : 'retrying',
        category: permanent ? 'outbound_permanent_failure'
          : dailyLimit ? 'd1_daily_limit' : 'outbound_retry',
        severity: permanent ? 'high' : 'medium', mailboxId: parsed.value.mailboxId,
        messageId: parsed.value.messageId,
        errorCode,
        summary: error instanceof Error ? error.message : 'Outbound processing failed',
        details: { attempt: message.attempts, retryDelaySeconds: delaySeconds, dailyLimit },
        now: dependencies.now(),
      });
      if (permanent) {
        try {
          await resolveDeadLettersForMessage(
            dependencies.db,
            'outbound',
            parsed.value.messageId,
            dependencies.now(),
          );
          message.ack();
          result.acknowledged += 1;
        } catch (resolutionError) {
          console.warn(JSON.stringify({
            event: 'outbound.dead_letter_resolution_failed',
            messageId: parsed.value.messageId,
            errorType: outboundErrorType(resolutionError),
          }));
          message.retry({ delaySeconds: queueRetryDelay(resolutionError, message.attempts, dependencies.now()) });
          result.retried += 1;
        }
      } else {
        message.retry({ delaySeconds });
        result.retried += 1;
      }
    }
  }
  return result;
}
