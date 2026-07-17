import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const SMTP2GO_API_KEY = /^api-[A-Za-z0-9_-]{32}$/u;

export async function validateDeploySecrets(pathInput) {
  const path = resolve(String(pathInput ?? ''));
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error('deployment secrets path must be a regular file');
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('deployment secrets file permissions must be 0600');
  }
  const text = await readFile(path, 'utf8');
  if (text.length > 4096) throw new Error('deployment secrets file is too large');
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error('deployment secrets file must be valid JSON');
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('deployment secrets file must contain a JSON object');
  }
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== 'SMTP2GO_API_KEY') {
    throw new Error('deployment secrets file must contain only SMTP2GO_API_KEY');
  }
  if (typeof input.SMTP2GO_API_KEY !== 'string' || !SMTP2GO_API_KEY.test(input.SMTP2GO_API_KEY)) {
    throw new Error('SMTP2GO_API_KEY has an invalid format');
  }
  return { path, names: ['SMTP2GO_API_KEY'] };
}
