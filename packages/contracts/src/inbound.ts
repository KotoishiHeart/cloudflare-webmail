export const INBOUND_QUEUE_SCHEMA_VERSION = 2 as const;
export const MAX_INBOUND_MESSAGE_BYTES = 25 * 1024 * 1024;

export type InboundRoutingAction = 'store' | 'quarantine';

export type InboundQueueMessageV2 = {
  schemaVersion: typeof INBOUND_QUEUE_SCHEMA_VERSION;
  messageId: string;
  mailboxId: string;
  rawKey: string;
  envelope: {
    from: string;
    to: string;
  };
  headers: {
    subject: string;
    messageId: string;
  };
  receivedAt: number;
  accountEmail: string;
  routing: {
    action: InboundRoutingAction;
    reason?: string;
    policy?: string;
  };
  staging: {
    encoding: 'identity';
    rawSize: number;
  };
};

export type InboundQueueMessage = InboundQueueMessageV2;

export type InboundQueueParseResult =
  | { ok: true; value: InboundQueueMessage }
  | { ok: false; issues: string[] };

export function parseInboundQueueMessage(input: unknown): InboundQueueParseResult {
  const issues: string[] = [];
  if (!isRecord(input)) return { ok: false, issues: ['message must be an object'] };

  if (input.schemaVersion !== INBOUND_QUEUE_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${INBOUND_QUEUE_SCHEMA_VERSION}`);
  }
  checkString(input.messageId, 'messageId', issues, 128);
  checkString(input.mailboxId, 'mailboxId', issues, 128);
  checkString(input.rawKey, 'rawKey', issues, 1024);
  if (typeof input.rawKey === 'string' && !input.rawKey.startsWith('staging/raw/')) {
    issues.push('rawKey must use the staging/raw/ prefix');
  }
  if (
    typeof input.rawKey === 'string'
    && typeof input.mailboxId === 'string'
    && typeof input.messageId === 'string'
    && !input.rawKey.endsWith(`/${input.mailboxId}/${input.messageId}.eml`)
  ) {
    issues.push('rawKey must end with mailboxId/messageId.eml');
  }

  if (!isRecord(input.envelope)) {
    issues.push('envelope must be an object');
  } else {
    // RFC 5321 uses an empty reverse-path for delivery status notifications.
    checkString(input.envelope.from, 'envelope.from', issues, 320, true);
    checkString(input.envelope.to, 'envelope.to', issues, 320);
  }

  if (!isRecord(input.headers)) {
    issues.push('headers must be an object');
  } else {
    checkString(input.headers.subject, 'headers.subject', issues, 240, true);
    checkString(input.headers.messageId, 'headers.messageId', issues, 320, true);
  }

  if (!Number.isSafeInteger(input.receivedAt) || Number(input.receivedAt) <= 0) {
    issues.push('receivedAt must be a positive safe integer');
  }
  checkString(input.accountEmail, 'accountEmail', issues, 320);

  if (!isRecord(input.routing)) {
    issues.push('routing must be an object');
  } else {
    if (input.routing.action !== 'store' && input.routing.action !== 'quarantine') {
      issues.push('routing.action must be store or quarantine');
    }
    checkOptionalString(input.routing.reason, 'routing.reason', issues, 500);
    checkOptionalString(input.routing.policy, 'routing.policy', issues, 64);
  }

  if (!isRecord(input.staging)) {
    issues.push('staging must be an object');
  } else {
    if (input.staging.encoding !== 'identity') {
      issues.push('staging.encoding must be identity');
    }
    if (
      !Number.isSafeInteger(input.staging.rawSize)
      || Number(input.staging.rawSize) < 0
      || Number(input.staging.rawSize) > MAX_INBOUND_MESSAGE_BYTES
    ) {
      issues.push(`staging.rawSize must be between 0 and ${MAX_INBOUND_MESSAGE_BYTES}`);
    }
  }

  return issues.length
    ? { ok: false, issues }
    : { ok: true, value: input as InboundQueueMessage };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkString(
  value: unknown,
  path: string,
  issues: string[],
  maxLength: number,
  allowEmpty = false,
) {
  if (typeof value !== 'string') {
    issues.push(`${path} must be a string`);
    return;
  }
  if (!allowEmpty && value.trim().length === 0) issues.push(`${path} must not be empty`);
  if (value.length > maxLength) issues.push(`${path} must not exceed ${maxLength} characters`);
}

function checkOptionalString(value: unknown, path: string, issues: string[], maxLength: number) {
  if (value === undefined) return;
  checkString(value, path, issues, maxLength, true);
}
