import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export function createLegacyMappingTemplate(inventory) {
  return {
    version: 1,
    kind: 'cf-webmail-legacy-mapping',
    sourceDatabaseSha256: inventory.source.databaseSha256,
    mappings: inventory.accounts.map((account) => ({
      sourceAddress: account.address,
      mailboxId: deterministicUuid(`legacy-mailbox\u0000${account.address}`),
      address: account.address,
    })),
    exclusions: [],
  };
}

export async function loadAndValidateLegacyMapping(path, inventory) {
  const input = JSON.parse(await readFile(path, 'utf8'));
  if (!record(input) || input.version !== 1 || input.kind !== 'cf-webmail-legacy-mapping') {
    throw new Error('legacy mapping must be cf-webmail-legacy-mapping version 1');
  }
  if (input.sourceDatabaseSha256 !== inventory.source.databaseSha256) {
    throw new Error('legacy mapping belongs to a different source database');
  }
  const known = new Set(inventory.accounts.map((account) => account.address));
  const mappings = array(input.mappings, 'mappings').map((mapping, index) => {
    if (!record(mapping)) throw new Error(`mappings[${index}] must be an object`);
    return {
      sourceAddress: email(mapping.sourceAddress, `mappings[${index}].sourceAddress`),
      mailboxId: uuid(mapping.mailboxId, `mappings[${index}].mailboxId`),
      address: email(mapping.address, `mappings[${index}].address`),
    };
  });
  const exclusions = array(input.exclusions, 'exclusions').map((exclusion, index) => {
    if (!record(exclusion)) throw new Error(`exclusions[${index}] must be an object`);
    const reason = String(exclusion.reason ?? '').trim();
    if (reason.length < 1 || reason.length > 500 || CONTROL.test(reason)) {
      throw new Error(`exclusions[${index}].reason must contain 1 to 500 visible characters`);
    }
    return {
      sourceAddress: email(exclusion.sourceAddress, `exclusions[${index}].sourceAddress`),
      reason,
    };
  });
  unique(mappings.map((mapping) => mapping.sourceAddress), 'mapped source address');
  unique(mappings.map((mapping) => mapping.mailboxId), 'target mailbox ID');
  unique(mappings.map((mapping) => mapping.address), 'target address');
  unique(exclusions.map((exclusion) => exclusion.sourceAddress), 'excluded source address');
  const assigned = new Set([
    ...mappings.map((mapping) => mapping.sourceAddress),
    ...exclusions.map((exclusion) => exclusion.sourceAddress),
  ]);
  if (assigned.size !== mappings.length + exclusions.length) {
    throw new Error('a source address cannot be both mapped and excluded');
  }
  for (const address of assigned) {
    if (!known.has(address)) throw new Error(`legacy mapping contains an unknown source address: ${address}`);
  }
  const required = inventory.accounts.filter((account) => account.counts.messages > 0);
  const missing = required.filter((account) => !assigned.has(account.address));
  if (missing.length > 0) {
    throw new Error(`legacy mapping leaves ${missing.length} message account(s) unassigned`);
  }
  return {
    version: 1,
    kind: input.kind,
    sourceDatabaseSha256: input.sourceDatabaseSha256,
    mappings,
    exclusions,
  };
}

export function legacyMappingSha256(mapping) {
  return createHash('sha256').update(JSON.stringify(mapping)).digest('hex');
}

function deterministicUuid(seed) {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function email(value, path) {
  const normalized = String(value ?? '').trim().toLowerCase();
  const at = normalized.indexOf('@');
  if (
    normalized.length < 3 || normalized.length > 320 || at < 1
    || at !== normalized.lastIndexOf('@') || at === normalized.length - 1
    || at > 64 || normalized.length - at - 1 > 255
    || /\s/u.test(normalized) || CONTROL.test(normalized)
  ) throw new Error(`${path} must be an email address`);
  return normalized;
}

function uuid(value, path) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!UUID.test(normalized)) throw new Error(`${path} must be a UUID`);
  return normalized;
}

function array(value, path) {
  if (!Array.isArray(value) || value.length > 1000) {
    throw new Error(`${path} must be an array with at most 1000 items`);
  }
  return value;
}

function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
