import { requireTimestamp } from './validation.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_RETENTION_DAYS = 365;
const DELIVERY_RETENTION_DAYS = 90;
const DELETE_LIMIT = 500;

export type EventRetentionResult = {
  auditDeleted: number;
  deliveryDeleted: number;
};

export async function pruneExpiredEvents(
  db: D1Database,
  nowInput: number,
): Promise<EventRetentionResult> {
  const now = requireTimestamp(nowInput);
  const delivery = await prune(
    db,
    'delivery_events',
    now - DELIVERY_RETENTION_DAYS * DAY_MS,
  );
  const audit = await prune(
    db,
    'audit_events',
    now - AUDIT_RETENTION_DAYS * DAY_MS,
  );
  return { auditDeleted: audit, deliveryDeleted: delivery };
}

async function prune(db: D1Database, table: 'audit_events' | 'delivery_events', cutoff: number) {
  const result = await db.prepare(`
    DELETE FROM ${table}
    WHERE id IN (
      SELECT id FROM ${table}
      WHERE created_at < ?
      ORDER BY created_at, id
      LIMIT ?
    )
  `).bind(cutoff, DELETE_LIMIT).run();
  return result.meta.changes;
}
