import { describe, expect, it } from 'vitest';
import {
  INBOUND_QUEUE_SCHEMA_VERSION,
  MAX_INBOUND_MESSAGE_BYTES,
  parseInboundQueueMessage,
  type InboundQueueMessage,
} from '@cf-webmail/contracts';

function validMessage(): InboundQueueMessage {
  return {
    schemaVersion: INBOUND_QUEUE_SCHEMA_VERSION,
    messageId: '0190f721-5f4c-7de3-9ec1-66c8619f748c',
    mailboxId: '0190f721-5f4c-7de3-9ec1-66c8619f748d',
    rawKey: 'staging/raw/2026/07/16/0190f721-5f4c-7de3-9ec1-66c8619f748d/0190f721-5f4c-7de3-9ec1-66c8619f748c.eml',
    envelope: { from: 'sender@example.net', to: 'inbox@example.com' },
    headers: { subject: 'hello', messageId: '<message@example.net>' },
    receivedAt: 1_752_688_800_000,
    accountEmail: 'inbox@example.com',
    routing: { action: 'store' },
    staging: { encoding: 'identity', rawSize: 1024 },
  };
}

describe('inbound Queue contract', () => {
  it('accepts the complete v1 contract', () => {
    expect(parseInboundQueueMessage(validMessage())).toEqual({ ok: true, value: validMessage() });
  });

  it('accepts an empty SMTP reverse-path for bounce messages', () => {
    const input = { ...validMessage(), envelope: { from: '', to: 'inbox@example.com' } };
    expect(parseInboundQueueMessage(input)).toEqual({ ok: true, value: input });
  });

  it('rejects unknown versions and unsafe R2 keys', () => {
    const input = { ...validMessage(), schemaVersion: 1, rawKey: 'raw/message.eml' };
    const result = parseInboundQueueMessage(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContain('schemaVersion must be 2');
      expect(result.issues).toContain('rawKey must use the staging/raw/ prefix');
    }
  });

  it('rejects messages above the inbound size limit', () => {
    const input = {
      ...validMessage(),
      staging: { encoding: 'identity', rawSize: MAX_INBOUND_MESSAGE_BYTES + 1 },
    };
    expect(parseInboundQueueMessage(input).ok).toBe(false);
  });
});
