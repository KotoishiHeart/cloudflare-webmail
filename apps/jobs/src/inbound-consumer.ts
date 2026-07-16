import { parseInboundQueueMessage } from '@cf-webmail/contracts';

const NOT_READY_RETRY_SECONDS = 300;

export type RetryableInboundMessage = Pick<Message<unknown>, 'body' | 'retry'>;

export type DeferredBatchResult = {
  valid: number;
  invalid: number;
};

export function deferUnimplementedInbound(
  messages: readonly RetryableInboundMessage[],
): DeferredBatchResult {
  let valid = 0;
  let invalid = 0;

  for (const message of messages) {
    const parsed = parseInboundQueueMessage(message.body);
    if (parsed.ok) {
      valid += 1;
      console.warn(JSON.stringify({
        event: 'inbound_processor_not_ready',
        messageId: parsed.value.messageId,
      }));
    } else {
      invalid += 1;
      console.error(JSON.stringify({
        event: 'inbound_contract_invalid',
        issues: parsed.issues,
      }));
    }
    message.retry({ delaySeconds: NOT_READY_RETRY_SECONDS });
  }

  return { valid, invalid };
}
