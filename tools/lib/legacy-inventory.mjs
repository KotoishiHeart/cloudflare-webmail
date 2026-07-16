import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readLegacyImportMetadata } from './legacy-sqlite.mjs';

export {
  createLegacyMappingTemplate,
  legacyMappingSha256,
  loadAndValidateLegacyMapping,
} from './legacy-mapping.mjs';

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
