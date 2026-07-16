import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assertLegacySafeBackup,
  classifyLegacyStatement,
  inspectLegacySafeSql,
  readLegacySqlStatements,
} from './legacy-safe-sql.mjs';

const FORMAT = 'cf-webmail-archived-safe-sql-v1';
const IMPORT_SCHEMA_VERSION = 1;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const REQUIRED_COLUMNS = {
  messages: [
    'id', 'direction', 'message_id', 'raw_sha256', 'subject', 'sender', 'recipients',
    'cc', 'date_header', 'received_at', 'text_preview', 'raw_key', 'body_text_key',
    'body_html_key', 'size', 'has_attachments', 'archived', 'compressed', 'created_at',
    'is_read', 'starred', 'deleted', 'deleted_at', 'account_email', 'bcc', 'in_reply_to',
    'references_header', 'source_message_id', 'compose_mode', 'send_status', 'provider',
  ],
  blobs: ['sha256', 'size', 'content_type', 'storage_key', 'filename_hint', 'ref_count', 'created_at'],
  attachments: ['id', 'message_id', 'blob_sha256', 'filename', 'content_type', 'size'],
  mail_accounts: [
    'id', 'email', 'local_part', 'domain', 'display_name', 'password_hash', 'quota_mb',
    'is_active', 'created_at', 'updated_at', 'allow_receive', 'allow_send', 'address_kind', 'notes',
  ],
};

export async function importLegacySafeSql(options) {
  const source = resolve(options.sql);
  const destination = resolve(options.database);
  await assertLegacySafeBackup(source);
  await assertMissing(destination);
  const sourceInfo = await stat(source);
  const sourceSha256 = await fileSha256(source);
  const schema = await inspectLegacySafeSql(source);
  addRequiredColumns(schema);
  requireArchivedTables(schema);

  let database;
  try {
    database = new DatabaseSync(destination);
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;');
    createCompatibilitySchema(database, schema);
    database.exec('BEGIN IMMEDIATE;');
    const inserted = Object.fromEntries([...schema.keys()].map((table) => [table, 0]));
    for await (const statement of readLegacySqlStatements(source)) {
      const operation = classifyLegacyStatement(statement);
      if (operation.kind === 'control') continue;
      if (!schema.has(operation.table)) throw new Error('legacy SQL references an undeclared table');
      database.exec(statement);
      if (operation.kind === 'insert') inserted[operation.table] += 1;
    }
    database.exec('COMMIT;');
    createReadIndexes(database, schema);
    const importedAt = options.now ?? Date.now();
    database.prepare(`
      INSERT INTO _legacy_import (
        format, schema_version, source_path, source_size, source_sha256, imported_at,
        inserted_rows_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      FORMAT,
      IMPORT_SCHEMA_VERSION,
      source,
      sourceInfo.size,
      sourceSha256,
      importedAt,
      JSON.stringify(inserted),
    );
    database.exec('PRAGMA synchronous = NORMAL; PRAGMA wal_checkpoint(TRUNCATE);');
    database.close();
    return {
      format: FORMAT,
      schemaVersion: IMPORT_SCHEMA_VERSION,
      database: destination,
      source: { path: source, size: sourceInfo.size, sha256: sourceSha256 },
      importedAt,
      inserted,
    };
  } catch (error) {
    try { database?.exec('ROLLBACK;'); } catch {}
    try { database?.close(); } catch {}
    await Promise.all([
      rm(destination, { force: true }),
      rm(`${destination}-shm`, { force: true }),
      rm(`${destination}-wal`, { force: true }),
    ]);
    throw error;
  }
}

export function readLegacyImportMetadata(database) {
  const row = database.prepare(`
    SELECT format, schema_version, source_path, source_size, source_sha256,
      imported_at, inserted_rows_json
    FROM _legacy_import
    LIMIT 1
  `).get();
  if (row?.format !== FORMAT || Number(row.schema_version) !== IMPORT_SCHEMA_VERSION) {
    throw new Error('database is not a supported archived webmail import');
  }
  return {
    format: row.format,
    schemaVersion: Number(row.schema_version),
    sourcePath: String(row.source_path),
    sourceSize: Number(row.source_size),
    sourceSha256: String(row.source_sha256),
    importedAt: Number(row.imported_at),
    inserted: JSON.parse(String(row.inserted_rows_json)),
  };
}

function addRequiredColumns(tables) {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tables.has(table)) continue;
    for (const column of columns) tables.get(table).add(column);
  }
}

function createCompatibilitySchema(database, schema) {
  for (const [table, columns] of schema) {
    const list = columns.size > 0 ? [...columns] : ['_legacy_empty'];
    database.exec(`CREATE TABLE ${quote(table)} (${list.map(quote).join(', ')});`);
  }
  database.exec(`
    CREATE TABLE _legacy_import (
      format TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      source_path TEXT NOT NULL,
      source_size INTEGER NOT NULL,
      source_sha256 TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      inserted_rows_json TEXT NOT NULL
    );
  `);
}

function createReadIndexes(database, schema) {
  if (schema.has('messages')) {
    database.exec(`
      CREATE INDEX idx_legacy_messages_account_time
        ON messages(account_email, received_at, id);
      CREATE INDEX idx_legacy_messages_raw_key ON messages(raw_key);
    `);
  }
  if (schema.has('attachments')) {
    database.exec('CREATE INDEX idx_legacy_attachments_message ON attachments(message_id);');
  }
  if (schema.has('blobs')) {
    database.exec('CREATE INDEX idx_legacy_blobs_sha256 ON blobs(sha256);');
  }
}

function quote(value) {
  if (!IDENTIFIER.test(value)) throw new Error('unsafe SQLite identifier');
  return `"${value}"`;
}

async function assertMissing(path) {
  try {
    await access(path);
    throw new Error(`legacy database already exists: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function requireArchivedTables(schema) {
  for (const table of ['messages', 'blobs', 'attachments', 'mail_accounts']) {
    if (!schema.has(table)) throw new Error(`legacy backup is missing table: ${table}`);
  }
}

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
