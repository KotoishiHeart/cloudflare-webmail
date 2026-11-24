import { access, rename, unlink, writeFile } from 'node:fs/promises';

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
