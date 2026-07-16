import { parseInboundQueueMessage } from '@cf-webmail/contracts';
import {
  failInboundHandoffProcessing,
  recordDeliveryEventSafely,
  resolveDeadLettersForMessage,
} from '@cf-webmail/database';
import { PermanentInboundError, errorType } from './inbound-errors.js';
import { isD1DailyLimitError, queueRetryDelay } from './queue-retry.js';
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
      await resolveDeadLettersForMessage(
        dependencies.db,
        'inbound',
        parsed.value.messageId,
        dependencies.now(),
      );
      message.ack();
      result.acknowledged += 1;
    } catch (error) {
      const permanent = error instanceof PermanentInboundError;
      const dailyLimit = !permanent && isD1DailyLimitError(error);
      const delaySeconds = permanent ? 0 : queueRetryDelay(error, message.attempts, dependencies.now());
      const errorCode = permanent ? error.code : dailyLimit ? 'd1_daily_limit' : 'transient';
      await recordHandoffFailure(
        dependencies,
        parsed.value.messageId,
        errorCode,
        error,
      );
      await recordDeliveryEventSafely(dependencies.db, {
        direction: 'inbound', stage: 'storage',
        status: permanent ? 'failed' : 'retrying',
        category: permanent ? 'inbound_permanent_failure'
          : dailyLimit ? 'd1_daily_limit' : 'inbound_retry',
        severity: permanent ? 'high' : 'medium', mailboxId: parsed.value.mailboxId,
        messageId: parsed.value.messageId,
        errorCode,
        summary: error instanceof Error ? error.message : 'Inbound processing failed',
        details: { attempt: message.attempts, retryDelaySeconds: delaySeconds, dailyLimit },
        now: dependencies.now(),
      });
      console.error(JSON.stringify({
        event: 'inbound.processing_failed',
        messageId: parsed.value.messageId,
        errorType: errorType(error),
        errorCode,
        attempt: message.attempts,
        retryDelaySeconds: delaySeconds,
      }));
      message.retry({ delaySeconds });
      result.retried += 1;
    }
  }
  return result;
}

async function recordHandoffFailure(
  dependencies: InboundProcessorDependencies,
  messageId: string,
  code: string,
  error: unknown,
): Promise<void> {
  try {
    await failInboundHandoffProcessing(
      dependencies.db,
      messageId,
      code,
      error,
      dependencies.now(),
    );
  } catch (handoffError) {
    console.warn(JSON.stringify({
      event: 'inbound.handoff_failure_mark_failed',
      messageId,
      errorType: errorType(handoffError),
    }));
  }
}
