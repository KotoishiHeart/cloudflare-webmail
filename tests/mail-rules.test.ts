import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyIncomingMailRulesSafely,
  persistInboundMessage,
  provisionMailboxWithOwner,
  provisionUserWithIdentity,
  setMailboxMembership,
  type MailRuleActions,
  type MailRuleConditions,
} from '@cf-webmail/database';
import type { AccessIdentity } from '../apps/web/src/access-auth.js';
import { handleWebRequest } from '../apps/web/src/app.js';

const ORIGIN = 'https://webmail.example.com';
const NOW = Date.UTC(2026, 6, 17, 5);
const OWNER_ID = '019c315c-1f20-7000-8000-000000000a01';
const VIEWER_ID = '019c315c-1f20-7000-8000-000000000a02';
const MAILBOX_ID = '019c315c-1f20-7000-8000-000000000a03';
const OTHER_MAILBOX_ID = '019c315c-1f20-7000-8000-000000000a04';
const MATCHING_MESSAGE_ID = '019c315c-1f20-7000-8000-000000000a05';
const OTHER_MESSAGE_ID = '019c315c-1f20-7000-8000-000000000a06';
const INCOMING_MESSAGE_ID = '019c315c-1f20-7000-8000-000000000a07';

const OWNER: AccessIdentity = {
  issuer: 'https://team.cloudflareaccess.com',
  subject: 'rules-owner',
  email: 'rules-owner@example.com',
};
const VIEWER: AccessIdentity = {
  issuer: OWNER.issuer,
  subject: 'rules-viewer',
  email: 'rules-viewer@example.com',
};

describe('mailbox mail rules', () => {
  beforeAll(async () => {
    await provisionUserWithIdentity(env.DB, {
      userId: OWNER_ID, email: OWNER.email, identity: OWNER, now: NOW,
    });
    await provisionUserWithIdentity(env.DB, {
      userId: VIEWER_ID, email: VIEWER.email, identity: VIEWER, now: NOW,
    });
    await provisionMailboxWithOwner(env.DB, {
      mailboxId: MAILBOX_ID, ownerUserId: OWNER_ID,
      address: 'rules@example.com', displayName: 'Rules', now: NOW,
    });
    await provisionMailboxWithOwner(env.DB, {
      mailboxId: OTHER_MAILBOX_ID, ownerUserId: OWNER_ID,
      address: 'other-rules@example.com', displayName: 'Other rules', now: NOW,
    });
    await setMailboxMembership(env.DB, {
      mailboxId: MAILBOX_ID, userId: VIEWER_ID, role: 'viewer', now: NOW + 1,
    });
    await message(MATCHING_MESSAGE_ID, '請求書 2026-07', 'billing@vendor.example', '支払期限', 'a');
    await message(OTHER_MESSAGE_ID, '週次ニュース', 'news@example.net', '更新情報', 'b');
    await message(INCOMING_MESSAGE_ID, '緊急通知', 'alert@example.net', '対応してください', 'c');
  });

  it('keeps rule management owner-only and enforces mailbox-scoped labels', async () => {
    const labelId = await createLabel(MAILBOX_ID, '請求書');
    const foreignLabelId = await createLabel(OTHER_MAILBOX_ID, '別メールボックス');
    const denied = await api(`/api/mailboxes/${MAILBOX_ID}/rules`, VIEWER);
    expect(denied.status).toBe(404);
    const crossMailbox = await api(`/api/mailboxes/${MAILBOX_ID}/rules`, OWNER, {
      method: 'POST',
      body: definition('不正なラベル', { labelIds: [foreignLabelId] }),
    });
    expect(crossMailbox.status).toBe(400);

    const created = await createRule('請求書を整理', {
      conditions: { subjectContains: '請求書' },
      actions: { star: true, archive: true, labelIds: [labelId] },
      applyExisting: true,
    });
    expect(created).toMatchObject({
      name: '請求書を整理', revision: 1, applyExisting: true,
      actions: { star: true, archive: true, labelIds: [labelId] },
    });
    const protectedLabel = await api(
      `/api/mailboxes/${MAILBOX_ID}/labels/${labelId}`,
      OWNER,
      { method: 'DELETE' },
    );
    expect(protectedLabel.status).toBe(400);
  });

  it('previews a frozen match set, applies it explicitly, and safely undoes it', async () => {
    const rules = await rulesList();
    const rule = rules.find((item) => item.name === '請求書を整理');
    if (rule === undefined) throw new Error('expected invoice rule');
    const previewResponse = await api(
      `/api/mailboxes/${MAILBOX_ID}/rules/${rule.id}/preview`,
      OWNER,
      { method: 'POST' },
    );
    expect(previewResponse.status).toBe(201);
    const preview = await previewResponse.json<{
      data: { run: { id: string; status: string; matchedCount: number }; matches: Array<{ messageId: string }> };
    }>();
    expect(preview.data.run).toMatchObject({ status: 'ready', matchedCount: 1 });
    expect(preview.data.matches.map((item) => item.messageId)).toEqual([MATCHING_MESSAGE_ID]);

    const appliedResponse = await api(
      `/api/mailboxes/${MAILBOX_ID}/rule-runs/${preview.data.run.id}/apply`,
      OWNER,
      { method: 'POST' },
    );
    expect(appliedResponse.status).toBe(200);
    const applied = await appliedResponse.json<{ data: { run: { id: string; changedCount: number } } }>();
    expect(applied.data.run.changedCount).toBe(1);
    await expect(flags(MATCHING_MESSAGE_ID)).resolves.toMatchObject({
      is_starred: 1, is_archived: 1, is_deleted: 0,
    });
    expect(await labelCount(MATCHING_MESSAGE_ID)).toBe(1);

    const undo = await api(
      `/api/mailboxes/${MAILBOX_ID}/rule-runs/${applied.data.run.id}/undo`,
      OWNER,
      { method: 'POST' },
    );
    expect(undo.status).toBe(200);
    await expect(flags(MATCHING_MESSAGE_ID)).resolves.toMatchObject({
      is_starred: 0, is_archived: 0, is_deleted: 0,
    });
    expect(await labelCount(MATCHING_MESSAGE_ID)).toBe(0);
  });

  it('rejects previews made before a rule revision', async () => {
    const rule = await createRule('変更検知', {
      conditions: { subjectContains: '週次' },
      actions: { star: true },
      applyExisting: true,
    });
    const preview = await api(
      `/api/mailboxes/${MAILBOX_ID}/rules/${rule.id}/preview`, OWNER, { method: 'POST' },
    ).then((response) => response.json<{ data: { run: { id: string } } }>());
    const patched = await api(`/api/mailboxes/${MAILBOX_ID}/rules/${rule.id}`, OWNER, {
      method: 'PATCH', body: { priority: 5 },
    });
    await expect(patched.json()).resolves.toMatchObject({ data: { rule: { revision: 2 } } });
    const stale = await api(
      `/api/mailboxes/${MAILBOX_ID}/rule-runs/${preview.data.run.id}/apply`,
      OWNER,
      { method: 'POST' },
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: 'stale_preview' });
  });

  it('applies incoming rules once and honors stop-processing order', async () => {
    const first = await createRule('緊急をゴミ箱へ', {
      priority: 1,
      conditions: { subjectContains: '緊急', direction: 'inbound' },
      actions: { trash: true },
      applyIncoming: true,
      stopProcessing: true,
    });
    await createRule('後続スター', {
      priority: 2,
      conditions: { subjectContains: '緊急' },
      actions: { star: true },
      applyIncoming: true,
    });
    const result = await applyIncomingMailRulesSafely(env.DB, MAILBOX_ID, INCOMING_MESSAGE_ID, NOW + 20);
    expect(result).toMatchObject({ matched: 1, changed: 1, stopped: true, failed: false });
    await expect(flags(INCOMING_MESSAGE_ID)).resolves.toMatchObject({
      is_deleted: 1, is_starred: 0,
    });
    const repeated = await applyIncomingMailRulesSafely(
      env.DB, MAILBOX_ID, INCOMING_MESSAGE_ID, NOW + 21,
    );
    expect(repeated).toMatchObject({ matched: 1, changed: 0, stopped: true, failed: false });
    const count = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM mail_rule_runs
      WHERE rule_id = ? AND target_message_id = ? AND mode = 'incoming'
    `).bind(first.id, INCOMING_MESSAGE_ID).first<{ count: number }>();
    expect(count).toEqual({ count: 1 });
  });
});

async function createRule(name: string, overrides: RuleOverrides = {}) {
  const response = await api(`/api/mailboxes/${MAILBOX_ID}/rules`, OWNER, {
    method: 'POST', body: definition(name, overrides),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ data: { rule: RuleResult } }>()).data.rule;
}

async function rulesList(): Promise<RuleResult[]> {
  const response = await api(`/api/mailboxes/${MAILBOX_ID}/rules`, OWNER);
  return (await response.json<{ data: { rules: RuleResult[] } }>()).data.rules;
}

async function createLabel(mailboxId: string, name: string): Promise<string> {
  const response = await api(`/api/mailboxes/${mailboxId}/labels`, OWNER, {
    method: 'POST', body: { name, color: '#2563eb' },
  });
  return (await response.json<{ data: { label: { id: string } } }>()).data.label.id;
}

type RuleOverrides = {
  priority?: number;
  conditions?: Partial<MailRuleConditions>;
  actions?: Partial<MailRuleActions>;
  applyExisting?: boolean;
  applyIncoming?: boolean;
  stopProcessing?: boolean;
  labelIds?: string[];
};

type RuleResult = { id: string; name: string; revision: number; [key: string]: unknown };

function definition(name: string, overrides: RuleOverrides = {}) {
  return {
    name,
    enabled: true,
    priority: overrides.priority ?? 100,
    conditions: {
      fromContains: '', toContains: '', subjectContains: '', participantDomain: '', keyword: '',
      attachment: 'any', minimumBytes: null, maximumBytes: null, direction: 'any',
      ...overrides.conditions,
    },
    actions: {
      star: false, archive: false, trash: false,
      labelIds: overrides.labelIds ?? [],
      ...overrides.actions,
    },
    applyExisting: overrides.applyExisting ?? false,
    applyIncoming: overrides.applyIncoming ?? false,
    stopProcessing: overrides.stopProcessing ?? false,
  };
}

async function message(id: string, subject: string, sender: string, preview: string, hash: string) {
  await persistInboundMessage(env.DB, {
    id, mailboxId: MAILBOX_ID, status: 'ready', processingError: '',
    envelopeFrom: sender, deliveredTo: 'rules@example.com',
    rfcMessageId: `<${id}@example.com>`, inReplyTo: '', referencesHeader: '',
    subject, sender, recipients: 'rules@example.com', cc: '', replyTo: '',
    dateHeader: 'Fri, 17 Jul 2026 05:00:00 GMT', receivedAt: NOW,
    textPreview: preview, rawKey: `mailboxes/${MAILBOX_ID}/messages/${id}/raw.eml`,
    rawSha256: hash.repeat(64), rawEtag: `etag-${hash}`, rawSize: 1024,
    bodyTextKey: null, bodyHtmlKey: null, attachments: [], createdAt: NOW,
  });
}

function flags(messageId: string) {
  return env.DB.prepare(`
    SELECT is_starred, is_archived, is_deleted FROM messages WHERE id = ?
  `).bind(messageId).first<Record<string, number>>();
}

async function labelCount(messageId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM message_labels WHERE message_id = ?',
  ).bind(messageId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

function api(
  path: string,
  identity: AccessIdentity,
  options: { method?: string; body?: Record<string, unknown>; origin?: string } = {},
): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = method === 'GET' ? {} : {
    origin: options.origin ?? ORIGIN,
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  return handleWebRequest(new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }), env, {
    authenticate: async () => ({ ok: true, identity }),
    now: () => NOW + 10,
  });
}
