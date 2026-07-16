import {
  advanceRetentionObjects,
  claimRetentionWork,
  deleteRetentionMetadata,
  failRetentionWork,
  finalizeRetentionRuns,
  recordDeliveryEventSafely,
  unreferencedRetentionObjectKeys,
} from '@cf-webmail/database';

const OBJECT_CHUNK_SIZE = 20;
const MAX_WORK_UNITS = 10;

export type RetentionProcessingResult = {
  claimed: number;
  metadataDeleted: number;
  skipped: number;
  objectChunksDeleted: number;
  completed: number;
  failed: number;
};

export async function processApprovedRetentionRuns(
  db: D1Database,
  rawEmails: R2Bucket,
  now: () => number = Date.now,
): Promise<RetentionProcessingResult> {
  const result: RetentionProcessingResult = {
    claimed: 0,
    metadataDeleted: 0,
    skipped: 0,
    objectChunksDeleted: 0,
    completed: 0,
    failed: 0,
  };
  for (let index = 0; index < MAX_WORK_UNITS; index += 1) {
    const work = await claimRetentionWork(db, {
      leaseOwner: crypto.randomUUID(), now: now(),
    });
    if (work === null) break;
    result.claimed += 1;
    try {
      if (work.status === 'candidate') {
        const metadata = await deleteRetentionMetadata(db, work, now());
        if (metadata === 'skipped') {
          result.skipped += 1;
          continue;
        }
        result.metadataDeleted += 1;
      }
      const keys = work.objectKeys.slice(
        work.nextObjectIndex,
        work.nextObjectIndex + OBJECT_CHUNK_SIZE,
      );
      if (keys.some((key) => key === '' || key.length > 1024)) {
        throw new Error('retention object key snapshot is invalid');
      }
      const deletableKeys = await unreferencedRetentionObjectKeys(db, keys);
      if (deletableKeys.length > 0) {
        await rawEmails.delete(deletableKeys);
        result.objectChunksDeleted += 1;
      }
      const nextObjectIndex = work.nextObjectIndex + keys.length;
      const completed = nextObjectIndex >= work.objectKeys.length;
      await advanceRetentionObjects(db, {
        work, nextObjectIndex, completed, now: now(),
      });
      if (completed) {
        result.completed += 1;
        await recordDeliveryEventSafely(db, {
          direction: 'system', stage: 'completed', status: 'succeeded',
          category: 'retention_hard_delete_completed', severity: 'high',
          mailboxId: work.mailboxId, messageId: work.messageId,
          summary: 'Approved retention hard delete completed',
          details: { runId: work.runId, objectCount: work.objectKeys.length },
          now: now(),
        });
      }
    } catch (error) {
      result.failed += 1;
      await failRetentionWork(db, work, error, now());
      await recordDeliveryEventSafely(db, {
        direction: 'system', stage: 'recovery', status: 'retrying',
        category: 'retention_hard_delete_retry', severity: 'high',
        mailboxId: work.mailboxId, messageId: work.messageId,
        errorCode: 'retention_delete_failed',
        summary: error instanceof Error ? error.message : 'Retention deletion failed',
        details: { runId: work.runId, attempt: work.attempts },
        now: now(),
      });
    }
  }
  await finalizeRetentionRuns(db, now());
  return result;
}
