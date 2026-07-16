import type { MailRuleConditions } from './mail-rule-domain.js';
import { normalizeId } from './validation.js';

export type MailRuleMatch = {
  id: string;
  subject: string;
  sender: string;
  receivedAt: number;
  rawSize: number;
  attachmentCount: number;
};

export async function listMailRuleMatches(
  db: D1Database,
  mailboxIdInput: string,
  conditions: MailRuleConditions,
  limitInput = 200,
  messageIdInput?: string,
): Promise<MailRuleMatch[]> {
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  const limit = Math.max(1, Math.min(200, Math.trunc(limitInput)));
  const where = buildMatchWhere(conditions, messageIdInput);
  const result = await db.prepare(`
    SELECT m.id, m.subject, m.sender, m.received_at, m.raw_size, m.attachment_count
    FROM messages AS m
    WHERE m.mailbox_id = ? AND ${where.sql}
    ORDER BY m.received_at DESC, m.id DESC LIMIT ?
  `).bind(mailboxId, ...where.params, limit).all<{
    id: string;
    subject: string;
    sender: string;
    received_at: number;
    raw_size: number;
    attachment_count: number;
  }>();
  return result.results.map((row) => ({
    id: row.id,
    subject: row.subject,
    sender: row.sender,
    receivedAt: row.received_at,
    rawSize: row.raw_size,
    attachmentCount: row.attachment_count,
  }));
}

function buildMatchWhere(conditions: MailRuleConditions, messageId?: string) {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (messageId !== undefined) {
    clauses.push('m.id = ?');
    params.push(normalizeId(messageId, 'messageId'));
  }
  if (conditions.direction !== 'any') {
    clauses.push('m.direction = ?');
    params.push(conditions.direction);
  }
  appendLike(clauses, params, 'm.sender', conditions.fromContains);
  if (conditions.toContains !== '') {
    const pattern = likePattern(conditions.toContains);
    clauses.push(`(m.recipients LIKE ? ESCAPE '^' OR m.cc LIKE ? ESCAPE '^'
      OR m.delivered_to LIKE ? ESCAPE '^' OR EXISTS (
        SELECT 1 FROM outbound_recipients AS recipient
        WHERE recipient.message_id = m.id AND recipient.address LIKE ? ESCAPE '^'
      ))`);
    params.push(pattern, pattern, pattern, pattern);
  }
  appendLike(clauses, params, 'm.subject', conditions.subjectContains);
  if (conditions.participantDomain !== '') {
    clauses.push(`EXISTS (
      SELECT 1 FROM message_search_documents AS sd
      WHERE sd.message_id = m.id AND sd.mailbox_id = m.mailbox_id
        AND sd.search_text LIKE ? ESCAPE '^'
    )`);
    params.push(likePattern(`@${conditions.participantDomain}`));
  }
  if (conditions.keyword !== '') {
    clauses.push(`EXISTS (
      SELECT 1 FROM message_search_documents AS sd
      WHERE sd.message_id = m.id AND sd.mailbox_id = m.mailbox_id
        AND sd.search_text LIKE ? ESCAPE '^'
    )`);
    params.push(likePattern(conditions.keyword));
  }
  if (conditions.attachment === 'with') clauses.push('m.attachment_count > 0');
  if (conditions.attachment === 'without') clauses.push('m.attachment_count = 0');
  if (conditions.minimumBytes !== null) {
    clauses.push('m.raw_size >= ?');
    params.push(conditions.minimumBytes);
  }
  if (conditions.maximumBytes !== null) {
    clauses.push('m.raw_size <= ?');
    params.push(conditions.maximumBytes);
  }
  return { sql: clauses.length === 0 ? '1 = 1' : clauses.join(' AND '), params };
}

function appendLike(
  clauses: string[],
  params: Array<string | number>,
  column: string,
  value: string,
): void {
  if (value === '') return;
  clauses.push(`${column} LIKE ? ESCAPE '^'`);
  params.push(likePattern(value));
}

function likePattern(value: string): string {
  return `%${value.toLowerCase().replace(/[\^%_]/gu, (match) => `^${match}`)}%`;
}
