import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const BACKUP_VERSION = 1;

const OBJECT_KEY_PATTERN = /^mailboxes\/[0-9a-f-]+\/messages\/[0-9a-f-]+\//u;

export function validateReferences(references) {
  if (!Array.isArray(references)) throw new Error('backup references must be an array');
  const seen = new Set();
  for (const reference of references) {
    validateObjectKey(reference.key, 'backup contains an invalid R2 key');
    validateContentType(reference.contentType, 'backup contains an invalid content type');
    if (seen.has(reference.key)) throw new Error(`duplicate R2 reference: ${reference.key}`);
    seen.add(reference.key);
  }
}

export function validateBackupManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object') {
    throw new Error('backup manifest structure is invalid');
  }
  if (manifest.version !== BACKUP_VERSION || manifest.kind !== 'cf-webmail-backup') {
    throw new Error('unsupported backup format');
  }
  if (
    !Array.isArray(manifest.objects)
    || manifest.counts === null
    || typeof manifest.counts !== 'object'
    || !Number.isSafeInteger(manifest.counts.objects)
    || manifest.counts.objects < 0
  ) {
    throw new Error('backup manifest structure is invalid');
  }
  if (manifest.d1?.file !== 'd1.sql') throw new Error('backup D1 path is invalid');
  validateFileDescriptor(manifest.d1);
  if (manifest.d1.size === 0) throw new Error('backup D1 export is empty');
}

export function validateObjectDescriptor(object) {
  if (object === null || typeof object !== 'object') {
    throw new Error('backup object descriptor is invalid');
  }
  validateObjectKey(object.key, 'backup object key is invalid');
  if (!/^objects\/\d{8}\.bin$/u.test(object.file)) throw new Error('backup object path is invalid');
  validateContentType(object.contentType, 'backup object content type is invalid');
  validateFileDescriptor(object);
}

export async function verifyDescriptor(root, descriptor) {
  const content = await readFile(join(root, descriptor.file));
  if (content.byteLength !== descriptor.size || sha256(content) !== descriptor.sha256) {
    throw new Error(`backup verification failed: ${descriptor.file}`);
  }
  return content;
}

export async function descriptorForFile(root, file) {
  const content = await readFile(join(root, file));
  return { file, size: content.byteLength, sha256: sha256(content) };
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validateObjectKey(key, message) {
  if (
    typeof key !== 'string'
    || !OBJECT_KEY_PATTERN.test(key)
    || key.length > 1024
    || /[\u0000-\u001f\u007f]/u.test(key)
  ) throw new Error(message);
}

function validateContentType(contentType, message) {
  if (
    typeof contentType !== 'string'
    || contentType.length < 1
    || contentType.length > 255
    || /[\u0000-\u001f\u007f]/u.test(contentType)
  ) throw new Error(message);
}

function validateFileDescriptor(descriptor) {
  if (
    descriptor === null
    || typeof descriptor !== 'object'
    || !Number.isSafeInteger(descriptor.size)
    || descriptor.size < 0
  ) {
    throw new Error('backup file size is invalid');
  }
  if (!/^[0-9a-f]{64}$/u.test(descriptor.sha256)) throw new Error('backup file hash is invalid');
}
