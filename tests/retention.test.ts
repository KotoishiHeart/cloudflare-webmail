import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  approveRetentionRun,
  createRetentionPreview,
  getRetentionRunDetail,
  persistInboundMessage,
  provisionMailboxWithOwner,
  provisionUserWithIdentity,
  saveRetentionPolicy,
} from '@cf-webmail/database';
import { processApprovedRetentionRuns } from '../apps/jobs/src/retention-runner.js';

const CREATED = Date.UTC(2026, 6, 1);
const PREVIEWED = Date.UTC(2026, 6, 17, 9);
const USER_ID = '019c315c-1f20-7000-8000-000000000e01';
const MAILBOX_ID = '019c315c-1f20-7000-8000-000000000e02';
const DELETE_ID = '019c315c-1f20-7000-8000-000000000e03';
const RESTORE_ID = '019c315c-1f20-7000-8000-000000000e04';

describe('retention hard deletion', () => {
  beforeAll(async () => {
    await provisionUserWithIdentity(env.DB, {
      userId: USER_ID, email: 'retention@example.com',
      identity: {
        issuer: 'https://team.cloudflareaccess.com', subject: 'retention',
        email: 'retention@example.com',
      },
      now: CREATED,
    });
    await provisionMailboxWithOwner(env.DB, {
      mailboxId: MAILBOX_ID, ownerUserId: USER_ID,
      address: 'retained@example.com', now: CREATED,
    });
    await saveRetentionPolicy(env.DB, {
      mailboxId: MAILBOX_ID, retentionDays: 1,
      excludeStarred: true, excludeLabeled: true, enabled: true, now: CREATED + 1,
    });
  });

  it('requires approval evidence and deletes D1 before resumable R2 cleanup', async () => {
    await fixture(DELETE_ID);
    const preview = await createRetentionPreview(env.DB, {
      mailboxId: MAILBOX_ID, userId: USER_ID, limit: 10, now: PREVIEWED,
    });
    expect(preview.status).toBe('created');
    if (preview.status !== 'created') throw new Error('preview failed');
    expect(preview.run.candidateCount).toBe(1);
    expect(await approveRetentionRun(env.DB, {
      runId: preview.run.id, userId: USER_ID,
      backupReference: 'backups/2026-07-17T09-00Z/manifest.json',
      backupManifestSha256: 'a'.repeat(64),
      backupCreatedAt: PREVIEWED + 1, now: PREVIEWED + 2,
    })).toBe('approved');

    const result = await processApprovedRetentionRuns(
      env.DB, env.RAW_EMAILS, () => PREVIEWED + 3,
    );
    expect(result.completed).toBe(1);
    expect(await env.DB.prepare('SELECT id FROM messages WHERE id = ?')
      .bind(DELETE_ID).first()).toBeNull();
    expect(await env.RAW_EMAILS.head(rawKey(DELETE_ID))).toBeNull();
    await expect(getRetentionRunDetail(env.DB, preview.run.id)).resolves.toMatchObject({
      run: { status: 'completed', completedCount: 1 },
      items: [{ status: 'completed' }],
    });
  });

  it('rechecks the frozen candidate and skips a restored message', async () => {
    await fixture(RESTORE_ID);
    const preview = await createRetentionPreview(env.DB, {
      mailboxId: MAILBOX_ID, userId: USER_ID, limit: 10, now: PREVIEWED + 10,
    });
    if (preview.status !== 'created') throw new Error('preview failed');
    await env.DB.prepare(`
      UPDATE messages SET is_deleted = 0, deleted_at = NULL, updated_at = ? WHERE id = ?
    `).bind(PREVIEWED + 11, RESTORE_ID).run();
    await approveRetentionRun(env.DB, {
      runId: preview.run.id, userId: USER_ID, backupReference: 'verified/restore-test',
      backupManifestSha256: 'b'.repeat(64),
      backupCreatedAt: PREVIEWED + 12, now: PREVIEWED + 13,
    });
    await processApprovedRetentionRuns(env.DB, env.RAW_EMAILS, () => PREVIEWED + 14);
    expect(await env.DB.prepare('SELECT is_deleted FROM messages WHERE id = ?')
      .bind(RESTORE_ID).first()).toEqual({ is_deleted: 0 });
    expect(await env.RAW_EMAILS.head(rawKey(RESTORE_ID))).not.toBeNull();
    await expect(getRetentionRunDetail(env.DB, preview.run.id)).resolves.toMatchObject({
      run: { status: 'completed', skippedCount: 1 },
      items: [{ status: 'skipped' }],
    });
  });
});

async function fixture(messageId: string): Promise<void> {
  const key = rawKey(messageId);
  const object = await env.RAW_EMAILS.put(key, 'raw');
  if (object === null) throw new Error('fixture R2 object was not stored');
  await persistInboundMessage(env.DB, {
    id: messageId, mailboxId: MAILBOX_ID, status: 'ready', processingError: '',
    envelopeFrom: 'sender@example.net', deliveredTo: 'retained@example.com',
    rfcMessageId: `<${messageId}@example.net>`, inReplyTo: '', referencesHeader: '',
    subject: `Retention ${messageId}`, sender: 'sender@example.net',
    recipients: 'retained@example.com', cc: '', replyTo: '', dateHeader: '',
    receivedAt: CREATED, textPreview: 'retention', rawKey: key,
    rawSha256: messageId.endsWith('3') ? 'c'.repeat(64) : 'd'.repeat(64),
    rawEtag: object.etag, rawSize: 3, bodyTextKey: null, bodyHtmlKey: null,
    attachments: [], createdAt: CREATED,
  });
  await env.DB.prepare(`
    UPDATE messages SET is_deleted = 1, deleted_at = ?, updated_at = ? WHERE id = ?
  `).bind(CREATED + 100, CREATED + 100, messageId).run();
}

function rawKey(messageId: string): string {
  return `mailboxes/${MAILBOX_ID}/messages/${messageId}/raw.eml`;
}
