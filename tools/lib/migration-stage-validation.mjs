const STAGE_VERSION = 1;
const LEGACY_STAGE_VERSION = 2;

export function validateStageManifest(manifest, objects) {
  if (!Array.isArray(manifest.sqlFiles)) throw new Error('stage SQL file list is invalid');
  const mailboxIds = manifest.version === STAGE_VERSION
    ? validateSingleMailboxManifest(manifest)
    : validateLegacyManifest(manifest);
  const objectKeys = new Set();
  const objectFiles = new Set();
  for (const object of objects) {
    const mailboxId = typeof object.key === 'string'
      ? object.key.match(/^mailboxes\/([^/]+)\/messages\//u)?.[1]
      : undefined;
    if (
      typeof object.key !== 'string'
      || mailboxId === undefined
      || !mailboxIds.has(mailboxId)
      || object.key.length > 1024
      || /[\u0000-\u001f\u007f]/u.test(object.key)
    ) throw new Error('stage object key is invalid');
    if (typeof object.file !== 'string' || !/^objects\/\d{8}\.bin$/u.test(object.file)) {
      throw new Error('stage object file path is invalid');
    }
    if (
      typeof object.contentType !== 'string'
      || object.contentType.length < 1
      || object.contentType.length > 255
      || /[\u0000-\u001f\u007f]/u.test(object.contentType)
    ) throw new Error('stage object content type is invalid');
    if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > 25 * 1024 * 1024) {
      throw new Error('stage object size is invalid');
    }
    if (!hash(object.sha256)) throw new Error('stage object hash is invalid');
    if (objectKeys.has(object.key) || objectFiles.has(object.file)) {
      throw new Error('stage contains a duplicate object key or file');
    }
    objectKeys.add(object.key);
    objectFiles.add(object.file);
  }
  for (const sqlFile of manifest.sqlFiles) {
    if (typeof sqlFile.file !== 'string' || !/^d1\/\d{6}\.sql$/u.test(sqlFile.file)) {
      throw new Error('stage SQL file path is invalid');
    }
    if (!Number.isSafeInteger(sqlFile.size) || sqlFile.size < 1) {
      throw new Error('stage SQL size is invalid');
    }
    if (!hash(sqlFile.sha256)) throw new Error('stage SQL hash is invalid');
  }
}

function validateSingleMailboxManifest(manifest) {
  if (!uuid(manifest.mailboxId)) throw new Error('stage mailbox ID is invalid');
  if (manifest.direction !== 'inbound' && manifest.direction !== 'outbound') {
    throw new Error('stage direction is invalid');
  }
  return new Set([manifest.mailboxId]);
}

function validateLegacyManifest(manifest) {
  if (
    manifest.sourceFormat !== 'cloudflare-webmail-archived-d1-r2'
    || !uuid(manifest.batchId)
    || !hash(manifest.sourceDatabaseSha256)
    || !hash(manifest.mappingSha256)
    || !hash(manifest.snapshotSha256)
    || typeof manifest.complete !== 'boolean'
    || !Array.isArray(manifest.mappings)
    || manifest.mappings.length < 1
    || manifest.mappings.length > 1000
    || !Array.isArray(manifest.exclusions)
  ) throw new Error('legacy stage manifest is invalid');
  const mailboxIds = new Set();
  const sourceAddresses = new Set();
  let discovered = 0;
  let prepared = 0;
  let failed = 0;
  for (const mapping of manifest.mappings) {
    if (
      typeof mapping?.sourceAddress !== 'string'
      || typeof mapping.address !== 'string'
      || !uuid(mapping.mailboxId)
      || !count(mapping.discovered)
      || !count(mapping.prepared)
      || !count(mapping.failed)
    ) throw new Error('legacy stage mapping is invalid');
    if (mailboxIds.has(mapping.mailboxId) || sourceAddresses.has(mapping.sourceAddress)) {
      throw new Error('legacy stage mapping is duplicated');
    }
    mailboxIds.add(mapping.mailboxId);
    sourceAddresses.add(mapping.sourceAddress);
    discovered += mapping.discovered;
    prepared += mapping.prepared;
    failed += mapping.failed;
  }
  if (
    discovered !== manifest.counts.discovered
    || prepared !== manifest.counts.prepared
    || failed !== manifest.counts.failed
    || !count(manifest.counts.duplicates)
    || !count(manifest.counts.quarantined)
    || !positiveCount(manifest.counts.sourceObjects)
    || !positiveCount(manifest.counts.objects)
    || manifest.counts.prepared + manifest.counts.failed !== manifest.counts.discovered
    || manifest.counts.quarantined > manifest.counts.prepared
    || manifest.complete !== (
      manifest.counts.failed === 0
      && manifest.counts.duplicates === 0
      && manifest.counts.prepared === manifest.counts.discovered
    )
  ) throw new Error('legacy stage counts are inconsistent');
  return mailboxIds;
}

function uuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function hash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveCount(value) {
  return Number.isSafeInteger(value) && value > 0;
}
