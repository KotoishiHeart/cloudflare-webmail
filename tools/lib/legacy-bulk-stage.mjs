import { createHash } from 'node:crypto';
import { chmod, copyFile, link, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { verifyMigrationStage } from './migration-stage.mjs';

export async function materializeLegacyR2Tree(stageInput, outputInput) {
  const stage = resolve(stageInput);
  const output = resolve(outputInput);
  const verified = await verifyMigrationStage(stage);
  if (![2, 3, 4].includes(verified.manifest.version) || verified.manifest.complete !== true) {
    throw new Error('bulk R2 materialization requires a complete legacy stage');
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  await chmod(output, 0o700);
  for (const object of verified.objects) {
    const source = resolveStageFile(stage, object.file);
    const destination = resolveObjectKey(output, object.key);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await chmod(dirname(destination), 0o700);
    if (!await identicalFile(source, destination, object)) {
      try {
        await link(source, destination);
      } catch (error) {
        if (error?.code !== 'EXDEV' && error?.code !== 'EPERM') throw error;
        await copyFile(source, destination, 1);
      }
    }
  }
  const result = {
    version: 1,
    kind: 'cf-webmail-legacy-r2-tree',
    batchId: verified.manifest.batchId,
    stageSha256: stageSha256(verified.manifest, verified.objects),
    objects: verified.objects.length,
    output,
  };
  await writeFile(`${output}.json`, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await chmod(`${output}.json`, 0o600);
  return { ...result, manifest: verified.manifest, descriptors: verified.objects };
}

export function stageSha256(manifest, objects) {
  const hash = createHash('sha256');
  hash.update(`${manifest.batchId}\n${manifest.sourceDatabaseSha256}\n${manifest.snapshotSha256}\n`);
  for (const object of objects) {
    hash.update(`${JSON.stringify([object.key, object.size, object.sha256])}\n`);
  }
  for (const file of manifest.sqlFiles) {
    hash.update(`${JSON.stringify([file.file, file.size, file.sha256])}\n`);
  }
  return hash.digest('hex');
}

async function identicalFile(source, destination, descriptor) {
  let sourceInfo;
  let destinationInfo;
  try {
    [sourceInfo, destinationInfo] = await Promise.all([stat(source), stat(destination)]);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (sourceInfo.dev === destinationInfo.dev && sourceInfo.ino === destinationInfo.ino) return true;
  if (destinationInfo.size !== descriptor.size) {
    throw new Error(`materialized R2 file has a conflicting size: ${descriptor.key}`);
  }
  const content = await readFile(destination);
  if (sha256(content) !== descriptor.sha256) {
    throw new Error(`materialized R2 file has a conflicting hash: ${descriptor.key}`);
  }
  return true;
}

function resolveStageFile(stage, file) {
  const path = resolve(stage, file);
  const prefix = stage.endsWith(sep) ? stage : `${stage}${sep}`;
  if (!path.startsWith(prefix)) throw new Error('stage object escapes the stage directory');
  return path;
}

function resolveObjectKey(root, key) {
  const path = resolve(root, key);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!path.startsWith(prefix)) throw new Error('R2 object key escapes the materialized tree');
  return path;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
