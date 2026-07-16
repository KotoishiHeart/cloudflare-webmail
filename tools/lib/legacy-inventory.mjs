import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readLegacyImportMetadata } from './legacy-sqlite.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export function createLegacyInventory(databasePath, now = Date.now()) {
  const database = new DatabaseSync(resolve(databasePath), { readOnly: true });
  try {
    const source = readLegacyImportMetadata(database);
    const accounts = accountInventory(database);
    const counts = {
      messages: scalar(database, 'SELECT COUNT(*) FROM messages'),
      inbound: scalar(database, "SELECT COUNT(*) FROM messages WHERE direction = 'in'"),
      outbound: scalar(database, "SELECT COUNT(*) FROM messages WHERE direction = 'sent'"),
      attachments: scalar(database, 'SELECT COUNT(*) FROM attachments'),
      blobs: scalar(database, 'SELECT COUNT(*) FROM blobs'),
      r2References: scalar(database, `
        SELECT
          (SELECT COUNT(*) FROM messages WHERE COALESCE(raw_key, '') <> '')
          + (SELECT COUNT(*) FROM messages WHERE COALESCE(body_text_key, '') <> '')
          + (SELECT COUNT(*) FROM messages WHERE COALESCE(body_html_key, '') <> '')
          + (SELECT COUNT(*) FROM attachments AS a JOIN blobs AS b ON b.sha256 = a.blob_sha256
             WHERE COALESCE(b.storage_key, '') <> '')
      `),
      uniqueR2Objects: scalar(database, `
        SELECT COUNT(*) FROM (
          SELECT raw_key AS key FROM messages WHERE COALESCE(raw_key, '') <> ''
          UNION SELECT body_text_key FROM messages WHERE COALESCE(body_text_key, '') <> ''
          UNION SELECT body_html_key FROM messages WHERE COALESCE(body_html_key, '') <> ''
          UNION SELECT storage_key FROM blobs WHERE COALESCE(storage_key, '') <> ''
        )
      `),
    };
    const integrity = {
      messagesWithoutAccount: scalar(database, "SELECT COUNT(*) FROM messages WHERE COALESCE(account_email, '') = ''"),
      messagesWithoutRawKey: scalar(database, "SELECT COUNT(*) FROM messages WHERE COALESCE(raw_key, '') = ''"),
      unsupportedDirections: scalar(database, "SELECT COUNT(*) FROM messages WHERE direction NOT IN ('in', 'sent')"),
      orphanAttachments: scalar(database, `
        SELECT COUNT(*) FROM attachments AS a
        LEFT JOIN messages AS m ON m.id = a.message_id WHERE m.id IS NULL
      `),
      missingAttachmentBlobs: scalar(database, `
        SELECT COUNT(*) FROM attachments AS a
        LEFT JOIN blobs AS b ON b.sha256 = a.blob_sha256 WHERE b.sha256 IS NULL
      `),
    };
    return {
      version: 1,
      kind: 'cf-webmail-legacy-inventory',
      createdAt: now,
      source: {
        format: source.format,
        databaseSha256: source.sourceSha256,
        sqlSize: source.sourceSize,
        importedAt: source.importedAt,
      },
      counts,
      integrity,
      accounts,
    };
  } finally {
    database.close();
  }
}

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

function accountInventory(database) {
  const accounts = new Map();
  for (const row of database.prepare(`
    SELECT LOWER(email) AS address, display_name, is_active
    FROM mail_accounts ORDER BY LOWER(email)
  `).all()) {
    const address = String(row.address ?? '');
    if (address === '') continue;
    accounts.set(address, {
      address,
      displayName: String(row.display_name ?? ''),
      active: Number(row.is_active ?? 0) === 1,
      counts: emptyCounts(),
    });
  }
  for (const row of database.prepare(`
    SELECT LOWER(account_email) AS address,
      COUNT(*) AS messages,
      SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS inbound,
      SUM(CASE WHEN direction = 'sent' THEN 1 ELSE 0 END) AS outbound,
      SUM(CASE WHEN COALESCE(is_read, 0) <> 0 THEN 1 ELSE 0 END) AS unread_inverse,
      SUM(CASE WHEN COALESCE(starred, 0) <> 0 THEN 1 ELSE 0 END) AS starred,
      SUM(CASE WHEN COALESCE(archived, 0) <> 0 THEN 1 ELSE 0 END) AS archived,
      SUM(CASE WHEN COALESCE(deleted, 0) <> 0 THEN 1 ELSE 0 END) AS deleted,
      COALESCE(SUM(CAST(size AS INTEGER)), 0) AS raw_bytes
    FROM messages GROUP BY LOWER(account_email) ORDER BY LOWER(account_email)
  `).all()) {
    const address = String(row.address ?? '');
    if (address === '') continue;
    const account = accounts.get(address) ?? {
      address, displayName: '', active: false, counts: emptyCounts(),
    };
    account.counts = {
      messages: Number(row.messages),
      inbound: Number(row.inbound),
      outbound: Number(row.outbound),
      read: Number(row.unread_inverse),
      starred: Number(row.starred),
      archived: Number(row.archived),
      deleted: Number(row.deleted),
      rawBytes: Number(row.raw_bytes),
      attachments: 0,
    };
    accounts.set(address, account);
  }
  for (const row of database.prepare(`
    SELECT LOWER(m.account_email) AS address, COUNT(*) AS attachments
    FROM attachments AS a JOIN messages AS m ON m.id = a.message_id
    GROUP BY LOWER(m.account_email)
  `).all()) {
    const account = accounts.get(String(row.address));
    if (account) account.counts.attachments = Number(row.attachments);
  }
  return [...accounts.values()].sort((left, right) => left.address.localeCompare(right.address));
}

function emptyCounts() {
  return { messages: 0, inbound: 0, outbound: 0, read: 0, starred: 0, archived: 0, deleted: 0, rawBytes: 0, attachments: 0 };
}

function scalar(database, sql) {
  const row = database.prepare(sql).get();
  return Number(Object.values(row ?? {})[0] ?? 0);
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
