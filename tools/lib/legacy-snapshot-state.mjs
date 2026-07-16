import { createHash } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { legacyMappingSha256 } from './legacy-inventory.mjs';
import { readLegacyImportMetadata } from './legacy-sqlite.mjs';

export const LEGACY_SNAPSHOT_FORMAT = 'cf-webmail-legacy-raw-snapshot';
export const LEGACY_SNAPSHOT_VERSION = 1;
export const MAX_LEGACY_RAW_BYTES = 25 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;

export async function initializeLegacySnapshot(snapshot, statePath, options) {
  try {
    await stat(statePath);
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(resolve(snapshot, 'objects'), { recursive: true });
  const sourceDatabase = new DatabaseSync(resolve(options.database), { readOnly: true });
  const state = new DatabaseSync(statePath);
  try {
    const imported = readLegacyImportMetadata(sourceDatabase);
    const mappingHash = legacyMappingSha256(options.mapping);
    state.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE snapshot_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE snapshot_objects (
        source_key TEXT PRIMARY KEY,
        file TEXT NOT NULL UNIQUE,
        compressed INTEGER NOT NULL CHECK (compressed IN (0, 1)),
        expected_raw_sha256 TEXT NOT NULL,
        expected_raw_size INTEGER NOT NULL,
        message_refs INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'missing', 'invalid')),
        stored_size INTEGER,
        stored_sha256 TEXT,
        error TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    const included = new Set(options.mapping.mappings.map((item) => item.sourceAddress));
    const select = sourceDatabase.prepare(`
      SELECT id, LOWER(account_email) AS account_email, raw_key, raw_sha256,
        CAST(size AS INTEGER) AS raw_size, CAST(compressed AS INTEGER) AS compressed
      FROM messages ORDER BY raw_key, id
    `);
    const insert = state.prepare(`
      INSERT INTO snapshot_objects (
        source_key, file, compressed, expected_raw_sha256, expected_raw_size,
        status, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `);
    const existing = state.prepare(`
      SELECT compressed, expected_raw_sha256, expected_raw_size
      FROM snapshot_objects WHERE source_key = ?
    `);
    const increment = state.prepare(`
      UPDATE snapshot_objects SET message_refs = message_refs + 1 WHERE source_key = ?
    `);
    const now = options.now ?? Date.now();
    let messageRefs = 0;
    state.exec('BEGIN IMMEDIATE;');
    for (const row of select.iterate()) {
      if (!included.has(String(row.account_email))) continue;
      const key = legacyR2Key(row.raw_key);
      const expectedHash = String(row.raw_sha256).toLowerCase();
      const expectedSize = Number(row.raw_size);
      const compressed = Number(row.compressed) === 1 ? 1 : 0;
      if (!SHA256.test(expectedHash)) throw new Error(`legacy message ${row.id} has an invalid raw hash`);
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_LEGACY_RAW_BYTES) {
        throw new Error(`legacy message ${row.id} exceeds the supported raw size`);
      }
      const prior = existing.get(key);
      if (prior === undefined) {
        const keyHash = sha256(Buffer.from(key));
        insert.run(
          key,
          `objects/${keyHash.slice(0, 2)}/${keyHash}.bin`,
          compressed,
          expectedHash,
          expectedSize,
          now,
        );
      } else {
        if (
          Number(prior.compressed) !== compressed
          || String(prior.expected_raw_sha256) !== expectedHash
          || Number(prior.expected_raw_size) !== expectedSize
        ) throw new Error(`legacy R2 key has conflicting D1 metadata: ${key}`);
        increment.run(key);
      }
      messageRefs += 1;
    }
    if (messageRefs === 0) throw new Error('legacy mapping selected no messages');
    setMeta(state, 'format', LEGACY_SNAPSHOT_FORMAT);
    setMeta(state, 'version', LEGACY_SNAPSHOT_VERSION);
    setMeta(state, 'source_database_sha256', imported.sourceSha256);
    setMeta(state, 'mapping_sha256', mappingHash);
    setMeta(state, 'message_refs', messageRefs);
    setMeta(state, 'created_at', now);
    state.exec('COMMIT;');
    state.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch (error) {
    try { state.exec('ROLLBACK;'); } catch {}
    state.close();
    sourceDatabase.close();
    await Promise.all([
      rm(statePath, { force: true }),
      rm(`${statePath}-shm`, { force: true }),
      rm(`${statePath}-wal`, { force: true }),
    ]);
    throw error;
  }
  state.close();
  sourceDatabase.close();
}

export function validateLegacySnapshotIdentity(state, options) {
  const sourceDatabase = new DatabaseSync(resolve(options.database), { readOnly: true });
  let imported;
  try {
    imported = readLegacyImportMetadata(sourceDatabase);
  } finally {
    sourceDatabase.close();
  }
  if (
    meta(state, 'format') !== LEGACY_SNAPSHOT_FORMAT
    || Number(meta(state, 'version')) !== LEGACY_SNAPSHOT_VERSION
  ) throw new Error('unsupported legacy snapshot');
  if (meta(state, 'source_database_sha256') !== imported.sourceSha256) {
    throw new Error('legacy snapshot belongs to a different source database');
  }
  if (meta(state, 'mapping_sha256') !== legacyMappingSha256(options.mapping)) {
    throw new Error('legacy snapshot belongs to a different account mapping');
  }
}

export function bindLegacySnapshotSource(state, source) {
  const value = JSON.stringify(source);
  const current = optionalMeta(state, 'source_identity');
  if (current !== null && current !== value) {
    throw new Error('legacy snapshot cannot resume from a different R2 source');
  }
  if (current === null) setMeta(state, 'source_identity', value);
}

export function legacySnapshotSummary(state) {
  const rows = state.prepare(`
    SELECT status, COUNT(*) AS count, COALESCE(SUM(stored_size), 0) AS stored_bytes
    FROM snapshot_objects GROUP BY status
  `).all();
  const counts = { pending: 0, ready: 0, missing: 0, invalid: 0 };
  let storedBytes = 0;
  for (const row of rows) {
    counts[row.status] = Number(row.count);
    storedBytes += Number(row.stored_bytes);
  }
  return {
    version: LEGACY_SNAPSHOT_VERSION,
    kind: LEGACY_SNAPSHOT_FORMAT,
    sourceDatabaseSha256: meta(state, 'source_database_sha256'),
    mappingSha256: meta(state, 'mapping_sha256'),
    messageReferences: Number(meta(state, 'message_refs')),
    objects: Object.values(counts).reduce((total, count) => total + count, 0),
    counts,
    storedBytes,
    complete: counts.pending === 0 && counts.missing === 0 && counts.invalid === 0,
  };
}

export function legacySnapshotSha256(state) {
  const summary = legacySnapshotSummary(state);
  if (!summary.complete) throw new Error('legacy snapshot is incomplete');
  const hash = createHash('sha256');
  hash.update(`${summary.sourceDatabaseSha256}\n${summary.mappingSha256}\n${summary.messageReferences}\n`);
  for (const row of state.prepare(`
    SELECT source_key, compressed, expected_raw_sha256, expected_raw_size,
      message_refs, stored_size, stored_sha256
    FROM snapshot_objects ORDER BY source_key
  `).iterate()) {
    hash.update(`${JSON.stringify([
      row.source_key,
      row.compressed,
      row.expected_raw_sha256,
      row.expected_raw_size,
      row.message_refs,
      row.stored_size,
      row.stored_sha256,
    ])}\n`);
  }
  return hash.digest('hex');
}

export function resolveLegacySnapshotFile(snapshot, file) {
  const path = resolve(snapshot, file);
  const prefix = snapshot.endsWith(sep) ? snapshot : `${snapshot}${sep}`;
  if (!path.startsWith(prefix)) throw new Error('snapshot file escapes the snapshot directory');
  return path;
}

function legacyR2Key(value) {
  const key = String(value ?? '');
  if (key.length < 1 || key.length > 1024 || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new Error('legacy R2 key is invalid');
  }
  return key;
}

function setMeta(state, key, value) {
  state.prepare('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)')
    .run(key, String(value));
}

function meta(state, key) {
  const value = optionalMeta(state, key);
  if (value === null) throw new Error(`legacy snapshot metadata is missing: ${key}`);
  return value;
}

function optionalMeta(state, key) {
  const row = state.prepare('SELECT value FROM snapshot_meta WHERE key = ?').get(key);
  return row === undefined ? null : String(row.value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
