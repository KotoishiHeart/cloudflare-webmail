import { describe, expect, it } from 'vitest';
import {
  OUTBOUND_QUEUE_SCHEMA_VERSION,
  createOutboundQueueMessage,
  parseOutboundQueueMessage,
} from '@cf-webmail/contracts';

describe('outbound Queue contract', () => {
  it('creates and accepts the ID-only contract', () => {
    const message = createOutboundQueueMessage(
      '019c315c-1f20-7000-8000-000000000501',
      '019c315c-1f20-7000-8000-000000000502',
    );
    expect(message.schemaVersion).toBe(OUTBOUND_QUEUE_SCHEMA_VERSION);
    expect(parseOutboundQueueMessage(message)).toEqual({ ok: true, value: message });
    expect(JSON.stringify(message)).not.toContain('@');
  });

  it('rejects unknown versions and malformed IDs', () => {
    const result = parseOutboundQueueMessage({
      schemaVersion: 2,
      messageId: '',
      mailboxId: 'x'.repeat(129),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toHaveLength(3);
  });
});
