import { DatabaseInputError, normalizeId } from './validation.js';

export type AdminEventCursor = { before: number; beforeId: string };
export type AdminAuditFilters = {
  category?: string;
  severity?: string;
  actorUserId?: string;
  mailboxId?: string;
  cursor?: AdminEventCursor;
  limit: number;
};
export type AdminDeliveryFilters = {
  direction?: string;
  status?: string;
  mailboxId?: string;
  messageId?: string;
  cursor?: AdminEventCursor;
  limit: number;
};

export async function listAdminAuditEvents(
  db: D1Database,
  filters: AdminAuditFilters,
) {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  addEnumFilter(clauses, values, 'category', filters.category, [
    'session', 'message', 'label', 'preference', 'rule', 'admin', 'retention', 'delivery',
  ]);
  addEnumFilter(clauses, values, 'severity', filters.severity, [
    'low', 'medium', 'high', 'critical',
  ]);
  addIdFilter(clauses, values, 'actor_user_id', filters.actorUserId, 'actorUserId');
  addIdFilter(clauses, values, 'mailbox_id', filters.mailboxId, 'mailboxId');
  addCursor(clauses, values, filters.cursor);
  const limit = normalizeLimit(filters.limit);
  const result = await db.prepare(`
    SELECT id, actor_user_id, actor_email, mailbox_id, category, severity,
      action, target_type, target_id, request_id, ip_address, user_agent,
      details_json, created_at
    FROM audit_events
    ${clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`}
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).bind(...values, limit + 1).all<Record<string, unknown>>();
  return page(result.results, limit);
}

export async function listAdminDeliveryEvents(
  db: D1Database,
  filters: AdminDeliveryFilters,
) {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  addEnumFilter(clauses, values, 'direction', filters.direction, [
    'inbound', 'outbound', 'system',
  ]);
  addEnumFilter(clauses, values, 'status', filters.status, [
    'info', 'succeeded', 'retrying', 'failed', 'rejected',
  ]);
  addIdFilter(clauses, values, 'mailbox_id', filters.mailboxId, 'mailboxId');
  if (filters.messageId !== undefined) {
    const messageId = filters.messageId.trim();
    if (messageId === '' || messageId.length > 128) {
      throw new DatabaseInputError('messageId', 'must be between 1 and 128 characters');
    }
    clauses.push('message_id = ?');
    values.push(messageId);
  }
  addCursor(clauses, values, filters.cursor);
  const limit = normalizeLimit(filters.limit);
  const result = await db.prepare(`
    SELECT id, direction, stage, status, category, severity, mailbox_id, message_id,
      provider, error_code, summary, details_json, created_at
    FROM delivery_events
    ${clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`}
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).bind(...values, limit + 1).all<Record<string, unknown>>();
  return page(result.results, limit);
}

function addEnumFilter(
  clauses: string[],
  values: (string | number)[],
  column: string,
  value: string | undefined,
  allowed: string[],
): void {
  if (value === undefined) return;
  if (!allowed.includes(value)) throw new DatabaseInputError(column, 'has an unsupported value');
  clauses.push(`${column} = ?`);
  values.push(value);
}

function addIdFilter(
  clauses: string[],
  values: (string | number)[],
  column: string,
  value: string | undefined,
  field: string,
): void {
  if (value === undefined) return;
  clauses.push(`${column} = ?`);
  values.push(normalizeId(value, field));
}

function addCursor(
  clauses: string[],
  values: (string | number)[],
  cursor: AdminEventCursor | undefined,
): void {
  if (cursor === undefined) return;
  if (!Number.isSafeInteger(cursor.before) || cursor.before <= 0 || cursor.beforeId === '') {
    throw new DatabaseInputError('cursor', 'is invalid');
  }
  clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
  values.push(cursor.before, cursor.before, cursor.beforeId);
}

function normalizeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new DatabaseInputError('limit', 'must be between 1 and 100');
  }
  return limit;
}

function page(rows: Record<string, unknown>[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    nextCursor: !hasMore || last === undefined ? null : {
      before: Number(last.created_at), beforeId: String(last.id),
    },
  };
}
