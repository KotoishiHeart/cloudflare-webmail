import { deterministicUuid } from './migration-message.mjs';

export function targetLabelId(mailboxId, labelKey) {
  return deterministicUuid(`legacy-label\u0000${mailboxId}\u0000${labelKey}`);
}

export function targetRuleId(mailboxId, sourceRuleId) {
  return deterministicUuid(`legacy-rule\u0000${mailboxId}\u0000${sourceRuleId}`);
}

export function compoundKey(left, right) {
  return `${left}\u0000${right}`;
}

export function ownerSql(mailboxId) {
  return `SELECT user_id FROM mailbox_memberships
    WHERE mailbox_id = ${q(mailboxId)} AND role = 'owner' ORDER BY user_id LIMIT 1`;
}

export function guard(conflictExpression) {
  return sql(`SELECT CASE WHEN ${conflictExpression.trim()}
    THEN json_extract('CF_WEBMAIL_MIGRATION_CONFLICT', '$') ELSE 1 END`);
}

export function values(items) {
  return items.map((value) => value === null
    ? 'NULL' : typeof value === 'number' ? String(value) : q(value)).join(', ');
}

export function q(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function flag(value) {
  return value ? 1 : 0;
}

export function sql(value) {
  return `${value.trim().replace(/^ {4}/gmu, '')};`;
}
