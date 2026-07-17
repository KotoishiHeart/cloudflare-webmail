const KINDS = [
  'message', 'message_flags', 'label', 'message_label', 'mail_rule', 'user_preference',
];
const CONFIGURATION_KINDS = ['label', 'message_label', 'mail_rule', 'user_preference'];

export function validateLegacyDeltaManifest(manifest, changes) {
  requireIdentity(manifest);
  const mailboxIds = validateMappings(manifest.mappings);
  const counts = manifest.counts;
  if (
    !positive(counts?.baselineMessages) || !positive(counts.finalMessages)
    || !count(counts.newMessages) || !count(counts.flagUpdates)
    || !count(counts.configurationMutations) || !count(counts.changes)
    || counts.failed !== 0 || !count(counts.quarantined)
    || !count(counts.sourceObjects) || !count(counts.objects)
    || counts.finalMessages !== counts.baselineMessages + counts.newMessages
    || counts.changes !== counts.newMessages + counts.flagUpdates
      + counts.configurationMutations
    || counts.quarantined > counts.newMessages
    || (counts.newMessages === 0) !== (manifest.messageBatchId === null)
    || (counts.newMessages === 0) !== (counts.objects === 0)
    || (counts.newMessages === 0) !== (counts.sourceObjects === 0)
  ) throw new Error('legacy delta stage counts are inconsistent');
  if (
    manifest.configuration?.mutations !== counts.configurationMutations
    || configurationCount(manifest.configuration?.counts) !== counts.configurationMutations
    || manifest.changesFile?.file !== 'changes.jsonl'
    || manifest.changesFile.count !== counts.changes
    || !count(manifest.changesFile.size)
    || manifest.changesFile.sha256 !== manifest.changeSetSha256
    || changes.length !== counts.changes
  ) throw new Error('legacy delta change set is inconsistent');
  validateChanges(changes, mailboxIds, counts);
  return mailboxIds;
}

function requireIdentity(manifest) {
  if (
    manifest.sourceFormat !== 'cloudflare-webmail-archived-d1-r2-delta'
    || !uuid(manifest.batchId) || manifest.deltaId !== manifest.batchId
    || !uuid(manifest.baselineBatchId)
    || (manifest.messageBatchId !== null && !uuid(manifest.messageBatchId))
    || !hash(manifest.baselineStageSha256) || !hash(manifest.sourceDatabaseSha256)
    || !hash(manifest.mappingSha256) || !hash(manifest.snapshotSha256)
    || !hash(manifest.changeSetSha256) || manifest.complete !== true
    || !Array.isArray(manifest.mappings) || manifest.mappings.length < 1
    || manifest.mappings.length > 1000 || !Array.isArray(manifest.exclusions)
  ) throw new Error('legacy delta stage manifest is invalid');
}

function validateMappings(mappings) {
  const mailboxIds = new Set();
  const addresses = new Set();
  for (const mapping of mappings) {
    if (
      typeof mapping?.sourceAddress !== 'string' || typeof mapping.address !== 'string'
      || !uuid(mapping.mailboxId) || mailboxIds.has(mapping.mailboxId)
      || addresses.has(mapping.sourceAddress)
    ) throw new Error('legacy delta stage mapping is invalid');
    mailboxIds.add(mapping.mailboxId);
    addresses.add(mapping.sourceAddress);
  }
  return mailboxIds;
}

function validateChanges(changes, mailboxIds, counts) {
  const unique = new Set();
  const actual = { message: 0, message_flags: 0, configuration: 0 };
  for (const change of changes) {
    const key = `${change.kind}\u0000${change.sourceKey}\u0000${change.targetKey}\u0000${change.action}`;
    const preference = change.kind === 'user_preference';
    if (
      !KINDS.includes(change.kind) || !['insert', 'update', 'delete'].includes(change.action)
      || (change.kind === 'message' && change.action !== 'insert')
      || (change.kind === 'message_flags' && change.action !== 'update')
      || typeof change.sourceKey !== 'string' || change.sourceKey.length < 1
      || change.sourceKey.length > 512
      || typeof change.targetKey !== 'string' || change.targetKey.length < 1
      || change.targetKey.length > 512 || !hash(change.expectedSha256)
      || (preference ? change.mailboxId !== null : !mailboxIds.has(change.mailboxId))
      || unique.has(key)
    ) throw new Error('legacy delta change is invalid');
    unique.add(key);
    if (CONFIGURATION_KINDS.includes(change.kind)) actual.configuration += 1;
    else actual[change.kind] += 1;
  }
  if (
    actual.message !== counts.newMessages
    || actual.message_flags !== counts.flagUpdates
    || actual.configuration !== counts.configurationMutations
  ) throw new Error('legacy delta change kinds do not match manifest counts');
}

function configurationCount(input) {
  if (typeof input !== 'object' || input === null) return -1;
  let total = 0;
  for (const kind of CONFIGURATION_KINDS) {
    const actions = input[kind];
    if (typeof actions !== 'object' || actions === null) return -1;
    for (const action of ['insert', 'update', 'delete']) {
      if (!count(actions[action])) return -1;
      total += actions[action];
    }
  }
  return total;
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

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}
