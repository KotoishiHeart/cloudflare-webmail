import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import {
  MAX_LEGACY_RAW_BYTES,
  resolveLegacySnapshotFile,
} from './legacy-snapshot-state.mjs';

const gunzipAsync = promisify(gunzip);

export async function verifyStoredSnapshotObject(snapshot, row) {
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
