import {
  getMaintenanceCursor,
  isStorageKeyReferenced,
  listStorageReferencePage,
  recordStorageIssue,
  resolveStorageIssue,
  saveMaintenanceCursor,
} from '@cf-webmail/database';

const REFERENCE_TASK = 'canonical-references';
const OBJECT_TASK = 'canonical-objects';
// Both audit directions together stay below the Workers Free 50-request cap.
const REFERENCE_BATCH_SIZE = 8;
const OBJECT_BATCH_SIZE = 8;

export type StorageAuditResult = {
  referencesScanned: number;
  missing: number;
  objectsScanned: number;
  orphaned: number;
};

export async function auditCanonicalStorage(
  db: D1Database,
  bucket: R2Bucket,
  now: number,
): Promise<StorageAuditResult> {
  const references = await auditReferences(db, bucket, now);
  const objects = await auditObjects(db, bucket, now);
  return { ...references, ...objects };
}

async function auditReferences(db: D1Database, bucket: R2Bucket, now: number) {
  const cursor = await getMaintenanceCursor(db, REFERENCE_TASK);
  const page = await listStorageReferencePage(db, cursor, REFERENCE_BATCH_SIZE);
  let missing = 0;
  for (const reference of page.references) {
    if (await bucket.head(reference.objectKey) === null) {
      await recordStorageIssue(db, 'canonical_object_missing', reference.objectKey, now, {
        mailboxId: reference.mailboxId,
        messageId: reference.messageId,
        details: reference.kind,
      });
      missing += 1;
    } else {
      await resolveStorageIssue(db, 'canonical_object_missing', reference.objectKey, now);
    }
  }
  await saveMaintenanceCursor(db, REFERENCE_TASK, page.nextCursor, now);
  return { referencesScanned: page.references.length, missing };
}

async function auditObjects(db: D1Database, bucket: R2Bucket, now: number) {
  const cursor = await getMaintenanceCursor(db, OBJECT_TASK);
  const listed = await bucket.list({
    prefix: 'mailboxes/',
    limit: OBJECT_BATCH_SIZE,
    ...(cursor === '' ? {} : { cursor }),
  });
  let orphaned = 0;
  for (const object of listed.objects) {
    if (!await isStorageKeyReferenced(db, object.key)) {
      await recordStorageIssue(db, 'orphan_canonical_object', object.key, now);
      orphaned += 1;
    } else {
      await resolveStorageIssue(db, 'orphan_canonical_object', object.key, now);
    }
  }
  await saveMaintenanceCursor(
    db,
    OBJECT_TASK,
    listed.truncated ? (listed.cursor ?? '') : '',
    now,
  );
  return { objectsScanned: listed.objects.length, orphaned };
}
