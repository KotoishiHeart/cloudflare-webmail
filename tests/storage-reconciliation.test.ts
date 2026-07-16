import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  INBOUND_QUEUE_SCHEMA_VERSION,
  buildInboundQueuePayloadKey,
  type InboundQueueMessage,
} from '@cf-webmail/contracts';
import {
  persistInboundMessage,
  provisionMailboxWithOwner,
  provisionUserWithIdentity,
  recordInboundHandoff,
} from '@cf-webmail/database';
import { reconcileInboundStaging } from '../apps/jobs/src/staging-reconciliation.js';
import { auditCanonicalStorage } from '../apps/jobs/src/storage-audit.js';

const NOW = Date.UTC(2026, 6, 16, 15);
const USER_ID = '019c315c-1f20-7000-8000-000000000801';
const MAILBOX_ID = '019c315c-1f20-7000-8000-000000000802';

describe('R2 storage reconciliation', () => {
  beforeAll(async () => {
    await provisionUserWithIdentity(env.DB, {
      userId: USER_ID,
      email: 'storage-owner@example.com',
      identity: {
        issuer: 'https://team.cloudflareaccess.com',
        subject: 'storage-owner',
      },
      now: NOW,
    });
    await provisionMailboxWithOwner(env.DB, {
      mailboxId: MAILBOX_ID,
      ownerUserId: USER_ID,
      address: 'storage@example.com',
      now: NOW,
    });
  });

  it('recovers a staged raw/contract pair that has no D1 handoff', async () => {
    const payload = inboundPayload('019c315c-1f20-7000-8000-000000000803');
    await putStagingPair(payload);
    const send = vi.fn(async () => {});
    const result = await reconcileInboundStaging(
      env.DB,
      env.RAW_EMAILS,
      { send } as unknown as Queue<unknown>,
      NOW + 1,
    );

    expect(result.recovered).toBe(1);
    expect(send).toHaveBeenCalledWith(payload, { contentType: 'json' });
    const handoff = await env.DB.prepare(`
      SELECT status FROM inbound_handoffs WHERE message_id = ?
    `).bind(payload.messageId).first<{ status: string }>();
    expect(handoff?.status).toBe('enqueued');
  });

  it('records incomplete staging without deleting it', async () => {
    const payload = inboundPayload('019c315c-1f20-7000-8000-000000000804');
    await env.RAW_EMAILS.put(payload.rawKey, 'raw only');
    const result = await reconcileInboundStaging(
      env.DB,
      env.RAW_EMAILS,
      { send: vi.fn(async () => {}) } as unknown as Queue<unknown>,
      NOW + 2,
    );

    expect(result.issues).toBeGreaterThan(0);
    await expect(env.RAW_EMAILS.get(payload.rawKey)).resolves.not.toBeNull();
    const issue = await env.DB.prepare(`
      SELECT status, details FROM storage_issues
      WHERE issue_type = 'orphan_staging_raw' AND object_key = ?
    `).bind(payload.rawKey).first<{ status: string; details: string }>();
    expect(issue).toMatchObject({ status: 'open', details: 'Queue contract sidecar is missing' });
  });

  it('retries cleanup for a stored handoff', async () => {
    const payload = inboundPayload('019c315c-1f20-7000-8000-000000000805');
    await putStagingPair(payload);
    await recordInboundHandoff(env.DB, payload, NOW);
    await env.DB.prepare(`
      UPDATE inbound_handoffs SET status = 'stored', staging_deleted = 0
      WHERE message_id = ?
    `).bind(payload.messageId).run();
    const result = await reconcileInboundStaging(
      env.DB,
      env.RAW_EMAILS,
      { send: vi.fn(async () => {}) } as unknown as Queue<unknown>,
      NOW + 3,
    );

    expect(result.cleaned).toBe(1);
    await expect(env.RAW_EMAILS.get(payload.rawKey)).resolves.toBeNull();
    await expect(env.RAW_EMAILS.get(
      buildInboundQueuePayloadKey(payload.rawKey),
    )).resolves.toBeNull();
    const handoff = await env.DB.prepare(`
      SELECT staging_deleted FROM inbound_handoffs WHERE message_id = ?
    `).bind(payload.messageId).first<{ staging_deleted: number }>();
    expect(handoff?.staging_deleted).toBe(1);
  });

  it('audits missing D1 references and unreferenced canonical objects', async () => {
    const messageId = '019c315c-1f20-7000-8000-000000000806';
    const rawKey = `mailboxes/${MAILBOX_ID}/messages/${messageId}/raw.eml`;
    const bodyKey = `mailboxes/${MAILBOX_ID}/messages/${messageId}/body.txt`;
    await persistInboundMessage(env.DB, {
      id: messageId,
      mailboxId: MAILBOX_ID,
      status: 'ready',
      processingError: '',
      envelopeFrom: 'sender@example.net',
      deliveredTo: 'storage@example.com',
      rfcMessageId: '',
      inReplyTo: '',
      referencesHeader: '',
      subject: 'audit',
      sender: 'sender@example.net',
      recipients: 'storage@example.com',
      cc: '',
      replyTo: '',
      dateHeader: '',
      receivedAt: NOW,
      textPreview: 'audit',
      rawKey,
      rawSha256: 'a'.repeat(64),
      rawEtag: 'etag',
      rawSize: 3,
      bodyTextKey: bodyKey,
      bodyHtmlKey: null,
      attachments: [],
      createdAt: NOW,
    });
    await env.RAW_EMAILS.put(rawKey, 'raw');
    const orphanKey = `mailboxes/${MAILBOX_ID}/messages/orphan/raw.eml`;
    await env.RAW_EMAILS.put(orphanKey, 'orphan');

    const result = await auditCanonicalStorage(env.DB, env.RAW_EMAILS, NOW + 4);
    expect(result).toMatchObject({ missing: 1, orphaned: 1 });
    const issues = await env.DB.prepare(`
      SELECT issue_type, object_key, status FROM storage_issues
      WHERE status = 'open' AND object_key IN (?, ?)
      ORDER BY issue_type
    `).bind(bodyKey, orphanKey).all<{
      issue_type: string;
      object_key: string;
      status: string;
    }>();
    expect(issues.results).toEqual([
      { issue_type: 'canonical_object_missing', object_key: bodyKey, status: 'open' },
      { issue_type: 'orphan_canonical_object', object_key: orphanKey, status: 'open' },
    ]);
  });
});

function inboundPayload(messageId: string): InboundQueueMessage {
  const rawKey = `staging/raw/2026/07/16/${MAILBOX_ID}/${messageId}.eml`;
  return {
    schemaVersion: INBOUND_QUEUE_SCHEMA_VERSION,
    messageId,
    mailboxId: MAILBOX_ID,
    rawKey,
    envelope: { from: 'sender@example.net', to: 'storage@example.com' },
    headers: { subject: 'storage recovery', messageId: '' },
    receivedAt: NOW,
    accountEmail: 'storage@example.com',
    routing: { action: 'store', policy: 'active-mailbox-v1' },
    staging: { encoding: 'identity', rawSize: 3 },
  };
}

async function putStagingPair(payload: InboundQueueMessage): Promise<void> {
  await Promise.all([
    env.RAW_EMAILS.put(payload.rawKey, 'raw'),
    env.RAW_EMAILS.put(buildInboundQueuePayloadKey(payload.rawKey), JSON.stringify(payload)),
  ]);
}
