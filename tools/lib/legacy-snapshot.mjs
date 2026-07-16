import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import {
  MAX_LEGACY_RAW_BYTES,
  bindLegacySnapshotSource,
  initializeLegacySnapshot,
  legacySnapshotSummary,
  resolveLegacySnapshotFile,
  validateLegacySnapshotIdentity,
} from './legacy-snapshot-state.mjs';

const execFileAsync = promisify(execFile);
const gunzipAsync = promisify(gunzip);
export async function fetchLegacySnapshot(options) {
  const snapshot = resolve(options.snapshot);
  const statePath = resolve(snapshot, 'snapshot.sqlite');
  await initializeLegacySnapshot(snapshot, statePath, options);
  const state = new DatabaseSync(statePath);
  try {
    validateLegacySnapshotIdentity(state, options);
    const source = sourceIdentity(options);
    bindLegacySnapshotSource(state, options.sourceIdentity ?? source);
    const rows = state.prepare(`
      SELECT source_key, file, compressed, expected_raw_sha256, expected_raw_size
      FROM snapshot_objects WHERE status <> 'ready' ORDER BY source_key
    `).all();
    const concurrency = integer(options.concurrency ?? 4, 1, 16, 'concurrency');
    await runPool(rows, concurrency, async (row) => {
      await fetchOne(snapshot, state, row, source, options.io);
    });
    return legacySnapshotSummary(state);
  } finally {
    state.close();
  }
}

export async function verifyLegacySnapshot(options) {
  const snapshot = resolve(options.snapshot);
  const state = new DatabaseSync(resolve(snapshot, 'snapshot.sqlite'));
  try {
    validateLegacySnapshotIdentity(state, options);
    const failures = [];
    for (const row of state.prepare(`
      SELECT source_key, file, compressed, expected_raw_sha256, expected_raw_size,
        stored_size, stored_sha256, status
      FROM snapshot_objects ORDER BY source_key
    `).iterate()) {
      if (row.status !== 'ready') {
        failures.push({ sourceKey: row.source_key, error: `snapshot object status is ${row.status}` });
        continue;
      }
      try {
        const verified = await verifyStoredObject(snapshot, row);
        if (verified.storedSize !== Number(row.stored_size)
          || verified.storedSha256 !== String(row.stored_sha256)) {
          throw new Error('stored object metadata does not match the snapshot database');
        }
      } catch (error) {
        failures.push({
          sourceKey: row.source_key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (failures.length > 0) {
      const error = new Error(`legacy snapshot verification failed for ${failures.length} object(s)`);
      error.failures = failures.slice(0, 100);
      throw error;
    }
    return legacySnapshotSummary(state);
  } finally {
    state.close();
  }
}

async function fetchOne(snapshot, state, row, source, io) {
  const destination = resolveLegacySnapshotFile(snapshot, row.file);
  const temporary = `${destination}.part`;
  await mkdir(dirname(destination), { recursive: true });
  await rm(temporary, { force: true });
  try {
    if (source.kind === 'directory') {
      await copyFile(resolveObjectRoot(source.root, row.source_key), temporary);
    } else {
      await downloadWithWrangler(source, row.source_key, temporary, io);
    }
    const verified = await verifyStoredObject(snapshot, { ...row, file: relative(snapshot, temporary) });
    await rename(temporary, destination);
    state.prepare(`
      UPDATE snapshot_objects SET status = 'ready', stored_size = ?, stored_sha256 = ?,
        error = '', updated_at = ? WHERE source_key = ?
    `).run(verified.storedSize, verified.storedSha256, Date.now(), row.source_key);
  } catch (error) {
    await rm(temporary, { force: true });
    const message = cleanError(error);
    const status = missingError(error) ? 'missing' : 'invalid';
    state.prepare(`
      UPDATE snapshot_objects SET status = ?, stored_size = NULL, stored_sha256 = NULL,
        error = ?, updated_at = ? WHERE source_key = ?
    `).run(status, message, Date.now(), row.source_key);
  }
}

async function verifyStoredObject(snapshot, row) {
  const path = resolveLegacySnapshotFile(snapshot, row.file);
  const info = await stat(path);
  if (info.size < 1 || info.size > MAX_LEGACY_RAW_BYTES + 1024 * 1024) {
    throw new Error('stored R2 object size is invalid');
  }
  const stored = await readFile(path);
  const raw = Number(row.compressed) === 1 ? await gunzipAsync(stored) : stored;
  if (raw.byteLength !== Number(row.expected_raw_size)) {
    throw new Error('uncompressed raw size does not match legacy D1');
  }
  if (raw.byteLength > MAX_LEGACY_RAW_BYTES || sha256(raw) !== row.expected_raw_sha256) {
    throw new Error('uncompressed raw SHA-256 does not match legacy D1');
  }
  return { storedSize: stored.byteLength, storedSha256: sha256(stored) };
}

async function downloadWithWrangler(source, key, destination, io) {
  const args = [
    '--no-install', 'wrangler', 'r2', 'object', 'get', `${source.bucket}/${key}`,
    '--file', destination, source.remote ? '--remote' : '--local',
    '--config', source.config,
  ];
  if (source.persistTo !== null) args.push('--persist-to', source.persistTo);
  if (io?.execFile) {
    const result = await io.execFile('npx', args);
    if (result?.error) throw result.error;
    if (result?.status !== undefined && result.status !== 0) {
      throw new Error(`wrangler exited with ${result.status}: ${result.stderr ?? ''}`);
    }
    return;
  }
  await execFileAsync('npx', args, { maxBuffer: 8 * 1024 * 1024 });
}

function sourceIdentity(options) {
  if (typeof options.objectRoot === 'string') {
    if (options.bucket !== undefined || options.remote || options.local) {
      throw new Error('--object-root cannot be combined with Wrangler R2 options');
    }
    return { kind: 'directory', root: resolve(options.objectRoot) };
  }
  if (typeof options.bucket !== 'string' || options.bucket === '') {
    throw new Error('specify --object-root or --bucket');
  }
  if (Boolean(options.remote) === Boolean(options.local)) {
    throw new Error('Wrangler R2 source requires exactly one of --local or --remote');
  }
  if (typeof options.config !== 'string' || options.config === '') {
    throw new Error('Wrangler R2 source requires --config');
  }
  return {
    kind: 'wrangler',
    bucket: options.bucket,
    remote: Boolean(options.remote),
    config: resolve(options.config),
    persistTo: options.persistTo === undefined ? null : resolve(options.persistTo),
  };
}

async function runPool(items, concurrency, task) {
  let offset = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (offset < items.length) {
      const item = items[offset];
      offset += 1;
      await task(item);
    }
  }));
}

function resolveObjectRoot(root, key) {
  if (isAbsolute(key)) throw new Error('legacy R2 key cannot be absolute');
  const path = resolve(root, key);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!path.startsWith(prefix)) throw new Error('legacy R2 key escapes the object root');
  return path;
}

function integer(value, minimum, maximum, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function cleanError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 1000);
}

function missingError(error) {
  return error?.code === 'ENOENT' || /(?:not found|no such key|\b404\b)/iu.test(cleanError(error));
}
