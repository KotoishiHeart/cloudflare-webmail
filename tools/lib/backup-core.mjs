import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  defaultRunner,
  downloadR2Object,
  exportD1,
  queryReferences,
  queryTargetTableCount,
  restoreD1,
  uploadR2Object,
} from './backup-cloudflare.mjs';
import {
  BACKUP_VERSION,
  descriptorForFile,
  sha256,
  validateBackupManifest,
  validateObjectDescriptor,
  validateReferences,
  verifyDescriptor,
} from './backup-format.mjs';

export async function createBackup(outputInput, options, runner = defaultRunner()) {
  requireTarget(options);
  if (options.persistTo) {
    throw new Error('Wrangler d1 export does not support --persist-to; use the default local state');
  }
  const output = resolve(outputInput);
  const manifestPath = join(output, 'manifest.json');
  if (await exists(manifestPath)) throw new Error('backup is already complete');
  await mkdir(join(output, 'objects'), { recursive: true });
  const target = targetMetadata(options);
  await bindTarget(join(output, 'backup-target.json'), target);
  const d1File = join(output, 'd1.sql');
  if (!await exists(d1File)) {
    const temporaryD1 = `${d1File}.partial`;
    await removePartial(temporaryD1);
    exportD1(temporaryD1, options, runner);
    await rename(temporaryD1, d1File);
  }
  const referencesFile = join(output, 'references.json');
  let references;
  if (await exists(referencesFile)) {
    references = JSON.parse(await readFile(referencesFile, 'utf8'));
  } else {
    references = queryReferences(options, runner);
    validateReferences(references);
    await writeJsonAtomic(referencesFile, references);
  }
  validateReferences(references);
  const objects = [];
  for (const [index, reference] of references.entries()) {
    const file = `objects/${String(index).padStart(8, '0')}.bin`;
    const sidecar = `objects/${String(index).padStart(8, '0')}.json`;
    const filePath = join(output, file);
    const sidecarPath = join(output, sidecar);
    let descriptor = await readValidSidecar(sidecarPath, filePath, reference);
    if (descriptor === null) {
      const temporaryObject = `${filePath}.partial`;
      await removePartial(temporaryObject);
      downloadR2Object(temporaryObject, reference.key, options, runner);
      await rename(temporaryObject, filePath);
      const content = await readFile(filePath);
      descriptor = {
        key: reference.key,
        file,
        contentType: reference.contentType,
        size: content.byteLength,
        sha256: sha256(content),
      };
      await writeJsonAtomic(sidecarPath, descriptor);
    }
    objects.push(descriptor);
  }
  const d1 = await descriptorForFile(output, 'd1.sql');
  const manifest = {
    version: BACKUP_VERSION,
    kind: 'cf-webmail-backup',
    createdAt: Date.now(),
    source: target,
    d1,
    objects,
    counts: { objects: objects.length },
  };
  await writeJsonAtomic(manifestPath, manifest);
  return manifest;
}

export async function verifyBackup(backupInput) {
  const backup = resolve(backupInput);
  const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
  validateBackupManifest(manifest);
  const d1Content = (await verifyDescriptor(backup, manifest.d1)).toString('utf8');
  const seen = new Set();
  for (const object of manifest.objects) {
    validateObjectDescriptor(object);
    if (seen.has(object.key)) throw new Error(`duplicate backup object key: ${object.key}`);
    seen.add(object.key);
    await verifyDescriptor(backup, object);
    if (!d1Content.includes(object.key)) {
      throw new Error(`D1 export does not reference object: ${object.key}`);
    }
  }
  if (manifest.counts.objects !== manifest.objects.length) {
    throw new Error('backup object count does not match manifest');
  }
  return manifest;
}

export async function restoreBackup(backupInput, options, runner = defaultRunner()) {
  requireTarget(options);
  if (!options.emptyTarget) throw new Error('restore requires --empty-target confirmation');
  const backup = resolve(backupInput);
  const manifest = await verifyBackup(backup);
  const target = targetMetadata(options);
  const targetId = sha256(Buffer.from(JSON.stringify(target))).slice(0, 16);
  const statePath = join(backup, `restore-state.${targetId}.json`);
  const state = await readRestoreState(statePath, target, manifest.objects.length);
  if (!state.d1Restored) {
    const tableCount = await queryTargetTableCount(options, runner);
    if (tableCount !== 0) throw new Error(`target D1 is not empty (${tableCount} user tables)`);
  }
  for (let index = state.nextObject; index < manifest.objects.length; index += 1) {
    const object = manifest.objects[index];
    uploadR2Object(join(backup, object.file), object, options, runner);
    state.nextObject = index + 1;
    await writeJsonAtomic(statePath, state);
  }
  if (!state.d1Restored) {
    restoreD1(join(backup, manifest.d1.file), options, runner);
    state.d1Restored = true;
  }
  state.completedAt = Date.now();
  await writeJsonAtomic(statePath, state);
  return state;
}

async function readValidSidecar(path, filePath, reference) {
  try {
    const descriptor = JSON.parse(await readFile(path, 'utf8'));
    if (descriptor.key !== reference.key || descriptor.contentType !== reference.contentType) return null;
    validateObjectDescriptor(descriptor);
    await verifyDescriptor(resolve(path, '..', '..'), descriptor);
    return descriptor;
  } catch {
    return null;
  }
}

async function bindTarget(path, target) {
  if (await exists(path)) {
    const existing = JSON.parse(await readFile(path, 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(target)) {
      throw new Error('partial backup belongs to a different source target');
    }
    return;
  }
  await writeJsonAtomic(path, target);
}

async function readRestoreState(path, target, objectCount) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (JSON.stringify(state.target) !== JSON.stringify(target)) {
      throw new Error('restore state belongs to a different target');
    }
    if (
      !Number.isSafeInteger(state.nextObject)
      || state.nextObject < 0
      || state.nextObject > objectCount
      || typeof state.d1Restored !== 'boolean'
    ) throw new Error('restore state is invalid');
    return {
      target,
      nextObject: state.nextObject,
      d1Restored: state.d1Restored,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { target, nextObject: 0, d1Restored: false };
    throw error;
  }
}

function targetMetadata(options) {
  return {
    mode: options.local ? 'local' : 'remote',
    database: options.database,
    bucket: options.bucket,
    config: options.config,
    persistTo: options.persistTo ?? null,
  };
}

function requireTarget(options) {
  if (Boolean(options.local) === Boolean(options.remote)) {
    throw new Error('specify exactly one of local or remote');
  }
  if (options.remote && options.persistTo) throw new Error('--persist-to is local-only');
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.partial`;
  await removePartial(temporary);
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, path);
}

async function removePartial(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
