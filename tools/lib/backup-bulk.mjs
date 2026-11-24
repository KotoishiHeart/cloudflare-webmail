import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { downloadR2ObjectsBulk } from './backup-cloudflare.mjs';

// Optional fast path for remote backups: when --rclone-source names the
// same bucket, all pending objects are fetched with a single parallel
// rclone copy instead of one Wrangler process per object. Objects already
// covered by a valid sidecar are skipped, and any object the bulk transfer
// did not produce falls back to the per-object Wrangler download, so the
// resulting manifest is identical either way.
export function bulkDownloadOptions(options) {
  if (options.rcloneSource === undefined || options.rcloneSource === null) return null;
  if (!options.remote) throw new Error('rclone bulk download requires a remote backup');
  const source = String(options.rcloneSource).trim().replace(/\/$/u, '');
  if (!/^[A-Za-z0-9_.-]+:[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(source)) {
    throw new Error('--rclone-source must be a named remote and bucket root (REMOTE:BUCKET)');
  }
  if (source.slice(source.indexOf(':') + 1) !== options.bucket) {
    throw new Error('--rclone-source bucket must match the backup bucket');
  }
  return {
    source,
    config: options.rcloneConfig ? resolve(options.rcloneConfig) : null,
    transfers: bulkInteger(options.transfers ?? 16, 1, 64, 'transfers'),
    checkers: bulkInteger(options.checkers ?? 32, 1, 128, 'checkers'),
  };
}

function bulkInteger(value, minimum, maximum, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

// Downloads every pending object into a staging tree inside the backup
// directory and records each entry's staged path. The returned cleanup
// removes the staging tree and the key list; the caller moves staged files
// into their final object slots before running it.
export async function stageBulkDownloads(output, pending, bulk, runner) {
  const bulkRoot = join(output, '.rclone-objects');
  const pendingList = join(output, '.rclone-pending-keys.txt');
  const cleanup = async () => {
    await Promise.all([
      rm(bulkRoot, { recursive: true, force: true }),
      rm(pendingList, { force: true }),
    ]);
  };
  await mkdir(bulkRoot, { recursive: true, mode: 0o700 });
  await chmod(bulkRoot, 0o700);
  await writeFile(
    pendingList,
    `${pending.map((entry) => entry.reference.key).join('\n')}\n`,
    { mode: 0o600 },
  );
  try {
    await downloadR2ObjectsBulk(pendingList, bulkRoot, {
      rcloneSource: bulk.source,
      rcloneConfig: bulk.config,
      transfers: bulk.transfers,
      checkers: bulk.checkers,
    }, runner);
  } catch (error) {
    await cleanup();
    throw error;
  }
  const bulkRootResolved = resolve(bulkRoot);
  for (const entry of pending) {
    const staged = resolve(join(bulkRoot, entry.reference.key));
    if (staged.startsWith(bulkRootResolved + sep)) entry.stagedPath = staged;
  }
  return cleanup;
}
