import {
  buildInboundQueuePayloadKey,
  parseInboundQueueMessage,
} from '@cf-webmail/contracts';
import {
  findInboundHandoff,
  getMaintenanceCursor,
  listInboundStagingCleanupPending,
  markInboundHandoffEnqueued,
  markInboundHandoffQueueFailed,
  markInboundStagingDeleted,
  recordInboundHandoff,
  recordStorageIssue,
  resolveStorageIssue,
  resolveStorageIssuesForKeys,
  saveMaintenanceCursor,
} from '@cf-webmail/database';

const STAGING_PREFIX = 'staging/raw/';
const STAGING_CURSOR_TASK = 'staging-objects';

export type StagingReconciliationResult = {
  scanned: number;
  recovered: number;
  issues: number;
  cleaned: number;
};

export async function reconcileInboundStaging(
  db: D1Database,
  bucket: R2Bucket,
  queue: Queue<unknown>,
  now: number,
): Promise<StagingReconciliationResult> {
  const result: StagingReconciliationResult = {
    scanned: 0,
    recovered: 0,
    issues: 0,
    cleaned: 0,
  };
  result.cleaned = await cleanupStoredStaging(db, bucket, now);
  const cursor = await getMaintenanceCursor(db, STAGING_CURSOR_TASK);
  const listed = await bucket.list({
    prefix: STAGING_PREFIX,
    limit: 50,
    ...(cursor === '' ? {} : { cursor }),
  });
  for (const object of listed.objects) {
    result.scanned += 1;
    if (object.key.endsWith('.queue.json')) {
      if (!await reconcilePayloadObject(db, bucket, object.key, now)) result.issues += 1;
      continue;
    }
    if (!object.key.endsWith('.eml')) {
      await recordStorageIssue(db, 'orphan_staging_raw', object.key, now, {
        details: 'unsupported staging object suffix',
      });
      result.issues += 1;
      continue;
    }
    const recovered = await reconcileRawObject(db, bucket, queue, object.key, now);
    if (recovered === 'recovered') result.recovered += 1;
    if (recovered === 'issue') result.issues += 1;
  }
  await saveMaintenanceCursor(
    db,
    STAGING_CURSOR_TASK,
    listed.truncated ? (listed.cursor ?? '') : '',
    now,
  );
  return result;
}

async function reconcilePayloadObject(
  db: D1Database,
  bucket: R2Bucket,
  payloadKey: string,
  now: number,
): Promise<boolean> {
  const rawKey = `${payloadKey.slice(0, -'.queue.json'.length)}.eml`;
  if (await bucket.head(rawKey) === null) {
    await recordStorageIssue(db, 'orphan_staging_payload', payloadKey, now);
    return false;
  }
  await resolveStorageIssue(db, 'orphan_staging_payload', payloadKey, now);
  return true;
}

async function reconcileRawObject(
  db: D1Database,
  bucket: R2Bucket,
  queue: Queue<unknown>,
  rawKey: string,
  now: number,
): Promise<'unchanged' | 'recovered' | 'issue'> {
  const payloadKey = buildInboundQueuePayloadKey(rawKey);
  const payloadObject = await bucket.get(payloadKey);
  if (payloadObject === null) {
    await recordStorageIssue(db, 'orphan_staging_raw', rawKey, now, {
      details: 'Queue contract sidecar is missing',
    });
    return 'issue';
  }
  let body: unknown;
  try {
    body = await payloadObject.json<unknown>();
  } catch {
    await recordStorageIssue(db, 'invalid_staging_payload', payloadKey, now, {
      details: 'Queue contract sidecar is not valid JSON',
    });
    return 'issue';
  }
  const parsed = parseInboundQueueMessage(body);
  if (!parsed.ok || parsed.value.rawKey !== rawKey) {
    await recordStorageIssue(db, 'invalid_staging_payload', payloadKey, now, {
      details: parsed.ok ? 'Queue contract raw key mismatch' : parsed.issues.join(', '),
    });
    return 'issue';
  }
  const existing = await findInboundHandoff(db, parsed.value.messageId);
  if (existing !== null) {
    if (existing.rawKey !== rawKey) {
      await recordStorageIssue(db, 'staging_recovery_failed', rawKey, now, {
        mailboxId: parsed.value.mailboxId,
        messageId: parsed.value.messageId,
        details: 'existing handoff raw key mismatch',
      });
      return 'issue';
    }
    await resolveStorageIssue(db, 'orphan_staging_raw', rawKey, now);
    await resolveStorageIssue(db, 'invalid_staging_payload', payloadKey, now);
    return 'unchanged';
  }
  try {
    await recordInboundHandoff(db, parsed.value, now);
    await queue.send(parsed.value, { contentType: 'json' });
    await markInboundHandoffEnqueued(db, parsed.value.messageId, now);
    await resolveStorageIssue(db, 'orphan_staging_raw', rawKey, now);
    await resolveStorageIssue(db, 'staging_recovery_failed', rawKey, now);
    return 'recovered';
  } catch (error) {
    await bestEffortMarkQueueFailure(db, parsed.value.messageId, error, now);
    await recordStorageIssue(db, 'staging_recovery_failed', rawKey, now, {
      mailboxId: parsed.value.mailboxId,
      messageId: parsed.value.messageId,
      details: error instanceof Error ? error.name : typeof error,
    });
    return 'issue';
  }
}

async function cleanupStoredStaging(
  db: D1Database,
  bucket: R2Bucket,
  now: number,
): Promise<number> {
  const pending = await listInboundStagingCleanupPending(db, 50);
  let cleaned = 0;
  for (const handoff of pending) {
    const keys = [handoff.rawKey, buildInboundQueuePayloadKey(handoff.rawKey)];
    try {
      await bucket.delete(keys);
      await markInboundStagingDeleted(db, handoff.messageId, now);
      await resolveStorageIssuesForKeys(db, keys, now);
      cleaned += 1;
    } catch (error) {
      await recordStorageIssue(db, 'staging_cleanup_failed', handoff.rawKey, now, {
        messageId: handoff.messageId,
        details: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return cleaned;
}

async function bestEffortMarkQueueFailure(
  db: D1Database,
  messageId: string,
  error: unknown,
  now: number,
): Promise<void> {
  try {
    await markInboundHandoffQueueFailed(db, messageId, error, now);
  } catch {
    // The storage issue remains open and the next full R2 scan retries recovery.
  }
}
