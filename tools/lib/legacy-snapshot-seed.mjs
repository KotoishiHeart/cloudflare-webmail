import { copyFile, chmod, link, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifyStoredSnapshotObject } from './legacy-snapshot-object.mjs';
import {
  legacyMappingSha256,
  legacyMappingTopologySha256,
} from './legacy-inventory.mjs';
import {
  legacySnapshotSha256,
  legacySnapshotSummary,
  resolveLegacySnapshotFile,
  validateLegacySnapshotFormat,
} from './legacy-snapshot-state.mjs';

export async function seedLegacySnapshot(options) {
  const snapshot = resolve(options.snapshot);
  const seedSnapshot = resolve(options.seedSnapshot);
  if (snapshot === seedSnapshot) throw new Error('seed snapshot must differ from the target snapshot');
  const target = new DatabaseSync(resolve(snapshot, 'snapshot.sqlite'));
  const seed = new DatabaseSync(resolve(seedSnapshot, 'snapshot.sqlite'), { readOnly: true });
  try {
    validateLegacySnapshotFormat(target);
    validateLegacySnapshotFormat(seed);
    const targetSummary = legacySnapshotSummary(target);
    const seedSummary = legacySnapshotSummary(seed);
    if (!seedSummary.complete) throw new Error('seed legacy snapshot is incomplete');
    if (legacyMappingSha256(options.mapping) !== targetSummary.mappingSha256) {
      throw new Error('target account mapping does not belong to the target legacy snapshot');
    }
    if (options.seedMapping === undefined) {
      throw new Error('seed legacy snapshot requires its validated account mapping');
    }
    if (legacyMappingSha256(options.seedMapping) !== seedSummary.mappingSha256) {
      throw new Error('seed account mapping does not belong to the seed legacy snapshot');
    }
    if (
      legacyMappingTopologySha256(options.seedMapping)
      !== legacyMappingTopologySha256(options.mapping)
    ) {
      throw new Error('seed legacy snapshot belongs to a different account mapping');
    }
    const seedSha256 = legacySnapshotSha256(seed);
    bindSeed(target, seedSha256);
    const lookup = seed.prepare(`
      SELECT source_key, file, compressed, expected_raw_sha256, expected_raw_size,
        stored_size, stored_sha256, status
      FROM snapshot_objects WHERE source_key = ?
    `);
    const update = target.prepare(`
      UPDATE snapshot_objects SET status = 'ready', stored_size = ?, stored_sha256 = ?,
        error = '', updated_at = ? WHERE source_key = ? AND status <> 'ready'
    `);
    let reusableObjects = 0;
    let linkedObjects = 0;
    for (const row of target.prepare(`
      SELECT source_key, file, compressed, expected_raw_sha256, expected_raw_size
      FROM snapshot_objects WHERE status <> 'ready' ORDER BY source_key
    `).iterate()) {
      const prior = lookup.get(row.source_key);
      if (!matchingObject(row, prior)) continue;
      reusableObjects += 1;
      const verified = await verifyStoredSnapshotObject(seedSnapshot, prior);
      const destination = resolveLegacySnapshotFile(snapshot, row.file);
      const temporary = `${destination}.seed.part`;
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await rm(temporary, { force: true });
      try {
        await linkOrCopy(resolveLegacySnapshotFile(seedSnapshot, prior.file), temporary);
        const copied = await verifyStoredSnapshotObject(snapshot, {
          ...row,
          file: relative(snapshot, temporary),
        });
        if (
          copied.storedSize !== verified.storedSize
          || copied.storedSha256 !== verified.storedSha256
        ) throw new Error('seeded snapshot object differs from its verified source');
        await rename(temporary, destination);
        await chmod(destination, 0o600);
        update.run(copied.storedSize, copied.storedSha256, Date.now(), row.source_key);
        linkedObjects += 1;
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    }
    return {
      snapshotSha256: seedSha256,
      reusableObjects,
      linkedObjects,
    };
  } finally {
    seed.close();
    target.close();
  }
}

function matchingObject(target, seed) {
  return seed !== undefined
    && seed.status === 'ready'
    && Number(seed.compressed) === Number(target.compressed)
    && String(seed.expected_raw_sha256) === String(target.expected_raw_sha256)
    && Number(seed.expected_raw_size) === Number(target.expected_raw_size);
}

function bindSeed(state, seedSha256) {
  const row = state.prepare("SELECT value FROM snapshot_meta WHERE key = 'seed_snapshot_sha256'").get();
  if (row !== undefined && String(row.value) !== seedSha256) {
    throw new Error('legacy snapshot cannot resume from a different seed snapshot');
  }
  if (row === undefined) {
    state.prepare("INSERT INTO snapshot_meta (key, value) VALUES ('seed_snapshot_sha256', ?)")
      .run(seedSha256);
  }
}

async function linkOrCopy(source, destination) {
  try {
    await link(source, destination);
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(error?.code)) throw error;
    await copyFile(source, destination);
  }
}
