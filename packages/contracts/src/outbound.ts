export const OUTBOUND_QUEUE_SCHEMA_VERSION = 1 as const;
export const OUTBOUND_QUEUE_NAME = 'cf-webmail-v2-outbound' as const;
export const OUTBOUND_DEAD_LETTER_QUEUE_NAME = 'cf-webmail-v2-outbound-dlq' as const;

export type OutboundQueueMessageV1 = {
  schemaVersion: typeof OUTBOUND_QUEUE_SCHEMA_VERSION;
  messageId: string;
  mailboxId: string;
};

export type OutboundQueueMessage = OutboundQueueMessageV1;

export type OutboundQueueParseResult =
  | { ok: true; value: OutboundQueueMessage }
  | { ok: false; issues: string[] };

export function createOutboundQueueMessage(
  messageId: string,
  mailboxId: string,
): OutboundQueueMessage {
  return { schemaVersion: OUTBOUND_QUEUE_SCHEMA_VERSION, messageId, mailboxId };
}

export function parseOutboundQueueMessage(input: unknown): OutboundQueueParseResult {
  const issues: string[] = [];
  if (!isRecord(input)) return { ok: false, issues: ['message must be an object'] };
  if (input.schemaVersion !== OUTBOUND_QUEUE_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${OUTBOUND_QUEUE_SCHEMA_VERSION}`);
  }
  checkId(input.messageId, 'messageId', issues);
  checkId(input.mailboxId, 'mailboxId', issues);
  return issues.length
    ? { ok: false, issues }
    : { ok: true, value: input as OutboundQueueMessage };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkId(value: unknown, path: string, issues: string[]): void {
  if (
    typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    issues.push(`${path} must be a UUID`);
  }
}
