import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { fetchLegacySnapshot } from './legacy-snapshot.mjs';
import {
  bindLegacySnapshotSource,
  initializeLegacySnapshot,
  validateLegacySnapshotIdentity,
} from './legacy-snapshot-state.mjs';

const execFileAsync = promisify(execFile);

export async function fetchLegacySnapshotBulk(options) {
  const snapshot = resolve(options.snapshot);
  const source = rcloneRoot(options.rcloneSource);
  const config = options.rcloneConfig === undefined ? null : resolve(options.rcloneConfig);
  const transfers = integer(options.transfers ?? 16, 1, 64, 'transfers');
  const checkers = integer(options.checkers ?? 32, 1, 128, 'checkers');
  const statePath = join(snapshot, 'snapshot.sqlite');
  await initializeLegacySnapshot(snapshot, statePath, options);
  const sourceIdentity = { kind: 'rclone-bulk', source, config };
  const state = new DatabaseSync(statePath);
  let rows;
  try {
    validateLegacySnapshotIdentity(state, options);
    bindLegacySnapshotSource(state, sourceIdentity);
    rows = state.prepare(`
      SELECT source_key, status FROM snapshot_objects ORDER BY source_key
    `).all().map((row) => ({ sourceKey: String(row.source_key), status: String(row.status) }));
  } finally {
    state.close();
  }
  const allKeys = `${rows.map((row) => row.sourceKey).join('\n')}\n`;
  const pendingKeys = `${rows.filter((row) => row.status !== 'ready')
    .map((row) => row.sourceKey).join('\n')}\n`;
  const sourceList = join(snapshot, 'rclone-source-keys.txt');
  const pendingList = join(snapshot, '.rclone-pending-keys.txt');
  await writeStable(sourceList, allKeys);
  const pending = rows.filter((row) => row.status !== 'ready').length;
  const bulkRoot = join(snapshot, '.rclone-source');
  if (pending > 0) {
    await writeFile(pendingList, pendingKeys, { mode: 0o600 });
    await mkdir(bulkRoot, { recursive: true, mode: 0o700 });
    await chmod(bulkRoot, 0o700);
    let processed = false;
    try {
      await run(options.io, ['version']);
      await run(options.io, [
        'copy', source, bulkRoot,
        '--files-from-raw', pendingList,
        '--no-traverse', '--immutable',
        '--transfers', String(transfers), '--checkers', String(checkers),
        ...(config === null ? [] : ['--config', config]),
      ]);
      const summary = await fetchLegacySnapshot({
        database: options.database,
        mapping: options.mapping,
        snapshot,
        objectRoot: bulkRoot,
        concurrency: options.concurrency,
        sourceIdentity,
      });
      processed = true;
      return withBulkEvidence(summary, source, rows.length, sourceList, allKeys, pending);
    } finally {
      if (processed) {
        await Promise.all([
          rm(bulkRoot, { recursive: true, force: true }),
          rm(pendingList, { force: true }),
        ]);
      }
    }
  }
  const summary = await fetchLegacySnapshot({
    database: options.database,
    mapping: options.mapping,
    snapshot,
    objectRoot: bulkRoot,
    concurrency: options.concurrency,
    sourceIdentity,
  });
  return withBulkEvidence(summary, source, rows.length, sourceList, allKeys, 0);
}

function withBulkEvidence(summary, source, sourceObjects, sourceList, listContent, copied) {
  return {
    ...summary,
    bulkSource: {
      source,
      sourceObjects,
      sourceList,
      sourceListSha256: sha256(listContent),
      copied,
    },
  };
}

async function writeStable(path, content) {
  try {
    const existing = await readFile(path, 'utf8');
    if (existing !== content) throw new Error('legacy bulk source key list changed');
    await chmod(path, 0o600);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  }
}

async function run(io, args) {
  const result = io?.execFile
    ? await io.execFile('rclone', args)
    : await execFileAsync('rclone', args, { maxBuffer: 8 * 1024 * 1024 });
  if (result?.error) throw result.error;
  if (result?.status !== undefined && result.status !== 0) {
    throw new Error(`rclone exited with ${result.status}: ${String(result.stderr ?? '').slice(0, 1000)}`);
  }
}

function rcloneRoot(value) {
  const normalized = String(value ?? '').trim().replace(/\/$/u, '');
  if (!/^[A-Za-z0-9_.-]+:[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(normalized)) {
    throw new Error('--rclone-source must be a named remote and bucket root (REMOTE:BUCKET)');
  }
  return normalized;
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
