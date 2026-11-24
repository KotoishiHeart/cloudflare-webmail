import { createHash, createHmac } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { backupLog } from './backup-files.mjs';

// Direct S3 fast path for remote backups: an alternative to the rclone
// mode that needs no external binary. Credentials live only in a local
// JSON keys file (--s3-keys, see tools/examples/r2-backup-keys.v1.json);
// they are loaded in memory, used to sign R2 S3 GET requests with
// Signature Version 4, and never written to the backup bundle, D1, or any
// manifest. Downloads run in parallel into a staging tree and are then
// moved into place by the caller exactly like the rclone staging, so the
// resulting backup is identical whichever mode produced it.
export function s3Options(options) {
  if (options.s3Keys === undefined || options.s3Keys === null) return null;
  if (!options.remote) throw new Error('S3 direct download requires a remote backup');
  return {
    keysFile: resolve(options.s3Keys),
    transfers: s3Integer(options.transfers ?? 16, 1, 64, 'transfers'),
  };
}

export async function loadS3Credentials(keysFile) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(keysFile, 'utf8'));
  } catch {
    throw new Error(`could not read S3 keys file: ${keysFile}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('S3 keys file must be a JSON object');
  }
  for (const key of Object.keys(parsed)) {
    if (!['accountId', 'accessKeyId', 'secretAccessKey'].includes(key)) {
      throw new Error(`S3 keys file contains an unknown field: ${key}`);
    }
  }
  const { accountId, accessKeyId, secretAccessKey } = parsed;
  if (typeof accountId !== 'string' || !/^[0-9a-f]{32}$/iu.test(accountId)) {
    throw new Error('S3 keys file accountId must be a 32-character hex account id');
  }
  validateKeyField('accessKeyId', accessKeyId, 128);
  validateKeyField('secretAccessKey', secretAccessKey, 256);
  return { accountId, accessKeyId, secretAccessKey };
}

function validateKeyField(name, value, maximum) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || /[\u0000-\u0020\u007f]/u.test(value)
  ) throw new Error(`S3 keys file ${name} is invalid`);
}

function s3Integer(value, minimum, maximum, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

// Downloads every pending object into a staging tree inside the backup
// directory and records each entry's staged path. Objects that fail after
// retries keep a null staged path so the caller falls back to the
// per-object Wrangler download; a rejected credential aborts the whole
// staging because retrying it object by object would not help.
export async function stageS3Downloads(output, pending, s3, runner) {
  const fetchImpl = runner?.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available for S3 downloads');
  const stagingRoot = join(output, '.s3-objects');
  const cleanup = async () => rm(stagingRoot, { recursive: true, force: true });
  await cleanup();
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await chmod(stagingRoot, 0o700);
  const stagingRootResolved = resolve(stagingRoot);
  const log = backupLog(runner);
  let cursor = 0;
  let completed = 0;
  let fatal = null;
  const worker = async () => {
    while (fatal === null && cursor < pending.length) {
      const entry = pending[cursor];
      cursor += 1;
      const staged = resolve(join(stagingRoot, entry.reference.key));
      if (staged.startsWith(stagingRootResolved + sep)) {
        try {
          await downloadWithRetries(fetchImpl, s3, entry.reference.key, staged);
          entry.stagedPath = staged;
        } catch (error) {
          if (error?.rejectedCredentials) fatal = error;
        }
      }
      completed += 1;
      if (completed % 100 === 0 || completed === pending.length) {
        log(`S3 download: ${completed}/${pending.length} objects\n`);
      }
    }
  };
  const workers = Math.min(s3.transfers, pending.length);
  await Promise.all(Array.from({ length: workers }, worker));
  if (fatal !== null) {
    await cleanup();
    throw fatal;
  }
  return cleanup;
}

async function downloadWithRetries(fetchImpl, s3, key, staged) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await downloadObject(fetchImpl, s3, key, staged);
      return;
    } catch (error) {
      if (error?.rejectedCredentials) throw error;
      lastError = error;
      if (attempt < 2) await new Promise((done) => setTimeout(done, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function downloadObject(fetchImpl, s3, key, staged) {
  const { url, headers } = signedGetRequest(s3, key, new Date());
  // A stalled connection must not hang the whole backup: bound each
  // attempt and let the retry loop above decide what happens next.
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    const error = new Error(`S3 GET failed with HTTP ${response.status} for ${key}`);
    if (response.status === 401 || response.status === 403) {
      error.rejectedCredentials = true;
      error.message = `S3 credentials were rejected with HTTP ${response.status}; check the --s3-keys file`;
    }
    throw error;
  }
  const content = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(staged), { recursive: true });
  await writeFile(staged, content);
}

function signedGetRequest(s3, key, now) {
  const { accountId, accessKeyId, secretAccessKey } = s3.credentials;
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${s3.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const amzDate = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}/u, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const headerValues = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const authorization = signS3Request({
    method: 'GET',
    host,
    canonicalUri,
    canonicalQuery: '',
    headerValues,
    payloadHash,
    credentials: { accessKeyId, secretAccessKey },
    region: 'auto',
    service: 's3',
    amzDate,
    dateStamp,
  });
  return {
    url: `https://${host}${canonicalUri}`,
    headers: { ...headerValues, authorization },
  };
}

// Minimal AWS Signature Version 4 signer (header-based, no query signing).
export function signS3Request(input) {
  const headers = { host: input.host, ...input.headerValues };
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames
    .map((name) => `${name}:${String(headers[name]).trim()}\n`)
    .join('');
  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    input.canonicalQuery,
    canonicalHeaders,
    signedNames.join(';'),
    input.payloadHash,
  ].join('\n');
  const scope = `${input.dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    input.amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const dateKey = hmac(`AWS4${input.credentials.secretAccessKey}`, input.dateStamp);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, input.service);
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmacHex(signingKey, stringToSign);
  return `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, `
    + `SignedHeaders=${signedNames.join(';')}, Signature=${signature}`;
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

function hmacHex(key, value) {
  return createHmac('sha256', key).update(value).digest('hex');
}
