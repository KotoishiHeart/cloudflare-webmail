import type { AccessIdentityKey } from './domain.js';
import { normalizeId, normalizeIssuer, normalizeSubject, requireTimestamp } from './validation.js';

export type AuditCategory =
  | 'session'
  | 'message'
  | 'label'
  | 'preference'
  | 'rule'
  | 'admin'
  | 'retention'
  | 'delivery';
export type EventSeverity = 'low' | 'medium' | 'high' | 'critical';

export async function recordIdentityAuditEventSafely(
  db: D1Database,
  input: {
    identity: AccessIdentityKey & { email?: string };
    mailboxId?: string;
    category: AuditCategory;
    severity?: EventSeverity;
    action: string;
    targetType?: string;
    targetId?: string;
    requestId?: string;
    ipAddress?: string;
    userAgent?: string;
    details?: Record<string, unknown>;
    now: number;
  },
): Promise<void> {
  try {
    const mailboxId = input.mailboxId === undefined
      ? null
      : normalizeId(input.mailboxId, 'mailboxId');
    const details = boundedJson(input.details ?? {});
    await db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, mailbox_id, category, severity,
        action, target_type, target_id, request_id, ip_address, user_agent,
        details_json, created_at
      )
      SELECT ?, u.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM access_identities AS ai
      JOIN users AS u ON u.id = ai.user_id
      WHERE ai.issuer = ? AND ai.subject = ?
      LIMIT 1
    `).bind(
      crypto.randomUUID(), bounded(input.identity.email ?? '', 320), mailboxId,
      input.category, input.severity ?? 'low', boundedRequired(input.action, 160),
      bounded(input.targetType ?? '', 80), bounded(input.targetId ?? '', 320),
      bounded(input.requestId ?? '', 128), bounded(input.ipAddress ?? '', 64),
      bounded(input.userAgent ?? '', 512), details, requireTimestamp(input.now),
      normalizeIssuer(input.identity.issuer), normalizeSubject(input.identity.subject),
    ).run();
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'audit.write_failed',
      action: input.action.slice(0, 80),
      errorType: error instanceof Error ? error.name : typeof error,
    }));
  }
}

function boundedJson(value: Record<string, unknown>): string {
  const serialized = JSON.stringify(value);
  return serialized.length <= 8192 ? serialized : JSON.stringify({ truncated: true });
}

function boundedRequired(value: string, max: number): string {
  const result = bounded(value, max);
  if (result === '') throw new Error('audit action is required');
  return result;
}

function bounded(value: string, max: number): string {
  return value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, max);
}
