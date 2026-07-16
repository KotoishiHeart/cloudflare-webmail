import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gunzipAsync = promisify(gunzip);
export const MAX_MIGRATION_MESSAGE_BYTES = 25 * 1024 * 1024;

export async function discoverMessageFiles(root, format) {
  if (format !== 'maildir' && format !== 'eml-tree') {
    throw new Error('format must be maildir or eml-tree');
  }
  const files = [];
  await walk(root, async (path) => {
    const name = path.toLowerCase();
    const rel = relative(root, path).replaceAll('\\', '/');
    const maildir = rel.split('/').some((part) => part === 'cur' || part === 'new');
    const eml = name.endsWith('.eml') || name.endsWith('.eml.gz');
    if ((format === 'maildir' && maildir) || (format === 'eml-tree' && eml)) {
      files.push({ path, relativePath: rel });
    }
  });
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function readMessageFile(file) {
  const info = await stat(file.path);
  if (info.size > MAX_MIGRATION_MESSAGE_BYTES) {
    throw new Error(`source exceeds ${MAX_MIGRATION_MESSAGE_BYTES} bytes`);
  }
  const stored = await readFile(file.path);
  const raw = file.path.toLowerCase().endsWith('.gz') ? await gunzipAsync(stored) : stored;
  if (raw.byteLength > MAX_MIGRATION_MESSAGE_BYTES) {
    throw new Error(`uncompressed source exceeds ${MAX_MIGRATION_MESSAGE_BYTES} bytes`);
  }
  return { raw, modifiedAt: Math.max(1, Math.floor(info.mtimeMs)) };
}

export function maildirFlags(relativePath) {
  const flagText = relativePath.match(/:2,([A-Za-z]+)$/u)?.[1] ?? '';
  const lower = relativePath.toLowerCase();
  return {
    isRead: flagText.includes('S'),
    isStarred: flagText.includes('F'),
    isDeleted: flagText.includes('T'),
    isArchived: lower.includes('archive') || lower.includes('archives'),
  };
}

async function walk(directory, onFile) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, onFile);
    else if (entry.isFile()) await onFile(path);
  }
}
