import type { EventSeverity } from './audit-events.js';
import { normalizeId, requireTimestamp } from './validation.js';

export type DeliveryDirection = 'inbound' | 'outbound' | 'system';
export type DeliveryStage =
  | 'routing'
  | 'staging'
  | 'queue'
  | 'parse'
  | 'storage'
  | 'rules'
  | 'provider'
  | 'completed'
  | 'recovery';
export type DeliveryStatus = 'info' | 'succeeded' | 'retrying' | 'failed' | 'rejected';

export async function recordDeliveryEventSafely(
  db: D1Database,
  input: {
    direction: DeliveryDirection;
    stage: DeliveryStage;
    status: DeliveryStatus;
    category: string;
    severity?: EventSeverity;
    mailboxId?: string;
    messageId?: string;
    provider?: string;
    errorCode?: string;
    summary?: string;
    details?: Record<string, unknown>;
    now: number;
  },
): Promise<void> {
  try {
    const detailsJson = JSON.stringify(input.details ?? {});
    await db.prepare(`
      INSERT INTO delivery_events (
        id, direction, stage, status, category, severity, mailbox_id, message_id,
        provider, error_code, summary, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), input.direction, input.stage, input.status,
      boundedRequired(input.category, 80), input.severity ?? 'low',
      input.mailboxId === undefined ? null : normalizeId(input.mailboxId, 'mailboxId'),
      bounded(input.messageId ?? '', 128), bounded(input.provider ?? '', 120),
      bounded(input.errorCode ?? '', 80), bounded(input.summary ?? '', 500),
      detailsJson.length <= 8192 ? detailsJson : JSON.stringify({ truncated: true }),
      requireTimestamp(input.now),
    ).run();
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'delivery_event.write_failed',
      category: input.category.slice(0, 80),
      errorType: error instanceof Error ? error.name : typeof error,
    }));
  }
}

function boundedRequired(value: string, max: number): string {
  const result = bounded(value, max);
  if (result === '') throw new Error('delivery category is required');
  return result;
}

function bounded(value: string, max: number): string {
  return value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, max);
}
