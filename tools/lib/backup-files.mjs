import { access, rename, unlink, writeFile } from 'node:fs/promises';

// Progress logging seam: the CLI runner logs to stderr so stdout stays a
// clean JSON summary; runners without a log function stay silent.
export function backupLog(runner) {
  return typeof runner?.log === 'function' ? (message) => runner.log(message) : () => {};
}

export async function writeJsonAtomic(path, value) {
  const temporary = `${path}.partial`;
  await removePartial(temporary);
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, path);
}

export async function removePartial(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
