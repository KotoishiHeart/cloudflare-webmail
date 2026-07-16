import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverMessageFiles, maildirFlags, readMessageFile } from './migration-source.mjs';
import { prepareMigratedMessage, sha256 } from './migration-message.mjs';
import { renderMigratedMessageSql } from './migration-sql.mjs';
import { validateStageManifest } from './migration-stage-validation.mjs';

const STAGE_VERSION = 1;
const LEGACY_STAGE_VERSION = 2;
const LEGACY_CONFIGURATION_STAGE_VERSION = 3;
const SQL_CHUNK_SIZE = 50;

export async function prepareMigrationStage(options) {
  const source = resolve(options.source);
  const stage = resolve(options.stage);
  await assertMissing(stage);
  const files = await discoverMessageFiles(source, options.format);
  if (files.length === 0) throw new Error('no importable messages were found');
  await mkdir(join(stage, 'objects'), { recursive: true });
  await mkdir(join(stage, 'd1'), { recursive: true });
  const createdAt = options.now ?? Date.now();
  const seen = new Set();
  const objects = [];
  const failures = [];
  const sqlChunks = [];
  let currentSql = [];
  let prepared = 0;
  let duplicates = 0;
  for (const file of files) {
    try {
      const sourceMessage = await readMessageFile(file);
      const message = await prepareMigratedMessage(sourceMessage.raw, {
        mailboxId: options.mailboxId,
        address: options.address,
        direction: options.direction,
        modifiedAt: sourceMessage.modifiedAt,
        flags: maildirFlags(file.relativePath),
      });
      if (seen.has(message.rawSha256)) {
        duplicates += 1;
        continue;
      }
      seen.add(message.rawSha256);
      await addObject(stage, objects, message.rawKey, message.raw, 'message/rfc822');
      if (message.bodyTextKey !== null) {
        await addObject(stage, objects, message.bodyTextKey, message.bodyText, 'text/plain; charset=utf-8');
      }
      if (message.bodyHtmlKey !== null) {
        await addObject(stage, objects, message.bodyHtmlKey, message.bodyHtml, 'text/html; charset=utf-8');
      }
      for (const attachment of message.attachments) {
        await addObject(stage, objects, attachment.key, attachment.content, attachment.contentType);
      }
      currentSql.push(renderMigratedMessageSql(message, createdAt));
      prepared += 1;
      if (currentSql.length >= SQL_CHUNK_SIZE) {
        sqlChunks.push(await writeSqlChunk(stage, sqlChunks.length, currentSql));
        currentSql = [];
      }
    } catch (error) {
      failures.push({
        source: file.relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (currentSql.length > 0) sqlChunks.push(await writeSqlChunk(stage, sqlChunks.length, currentSql));
  await writeFile(
    join(stage, 'objects.jsonl'),
    objects.map((object) => JSON.stringify(object)).join('\n') + '\n',
  );
  await writeFile(
    join(stage, 'failures.jsonl'),
    failures.map((failure) => JSON.stringify(failure)).join('\n') + (failures.length ? '\n' : ''),
  );
  const manifest = {
    version: STAGE_VERSION,
    kind: 'cf-webmail-migration-stage',
    createdAt,
    sourceFormat: options.format,
    mailboxId: options.mailboxId,
    address: options.address,
    direction: options.direction,
    counts: { discovered: files.length, prepared, duplicates, failed: failures.length, objects: objects.length },
    sqlFiles: sqlChunks,
  };
  await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export async function verifyMigrationStage(stageInput) {
  const stage = resolve(stageInput);
  const manifest = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8'));
  if (
    ![STAGE_VERSION, LEGACY_STAGE_VERSION, LEGACY_CONFIGURATION_STAGE_VERSION]
      .includes(manifest.version)
    || manifest.kind !== 'cf-webmail-migration-stage'
  ) {
    throw new Error('unsupported migration stage');
  }
  const objects = await readJsonLines(join(stage, 'objects.jsonl'));
  if (objects.length !== manifest.counts.objects) throw new Error('object count does not match manifest');
  const failures = await readJsonLines(join(stage, 'failures.jsonl'));
  if (failures.length !== manifest.counts.failed) throw new Error('failure count does not match manifest');
  validateStageManifest(manifest, objects);
  for (const object of objects) {
    const content = await readFile(join(stage, object.file));
    if (content.byteLength !== object.size || sha256(content) !== object.sha256) {
      throw new Error(`object verification failed: ${object.key}`);
    }
  }
  for (const sqlFile of manifest.sqlFiles) {
    const content = await readFile(join(stage, sqlFile.file));
    if (content.byteLength !== sqlFile.size || sha256(content) !== sqlFile.sha256) {
      throw new Error(`SQL verification failed: ${sqlFile.file}`);
    }
  }
  return { manifest, objects };
}

export async function applyMigrationStage(stageInput, options, io = { spawn: spawnSync }) {
  const stage = resolve(stageInput);
  const verified = await verifyMigrationStage(stage);
  if (verified.manifest.version >= LEGACY_STAGE_VERSION && verified.manifest.complete !== true) {
    throw new Error('incomplete legacy migration stages cannot be applied');
  }
  const target = {
    mode: options.local ? 'local' : 'remote',
    bucket: options.bucket,
    database: options.database,
    config: options.config,
    persistTo: options.persistTo ?? null,
  };
  const targetId = sha256(Buffer.from(JSON.stringify(target))).slice(0, 16);
  const statePath = join(stage, `apply-state.${targetId}.json`);
  const state = await readState(statePath, target);
  for (let index = state.nextObject; index < verified.objects.length; index += 1) {
    const object = verified.objects[index];
    runWrangler([
      'r2', 'object', 'put', `${options.bucket}/${object.key}`,
      '--file', join(stage, object.file), '--content-type', object.contentType,
      targetFlag(options), ...persistenceArgs(options), '--config', options.config,
    ], io);
    state.nextObject = index + 1;
    await writeState(statePath, state);
  }
  for (let index = state.nextSql; index < verified.manifest.sqlFiles.length; index += 1) {
    const sqlFile = verified.manifest.sqlFiles[index];
    runWrangler([
      'd1', 'execute', options.database, targetFlag(options),
      ...persistenceArgs(options),
      '--file', join(stage, sqlFile.file), '--config', options.config,
    ], io);
    state.nextSql = index + 1;
    await writeState(statePath, state);
  }
  state.completedAt = Date.now();
  await writeState(statePath, state);
  return state;
}

async function addObject(stage, objects, key, value, contentType) {
  const content = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  const file = `objects/${String(objects.length).padStart(8, '0')}.bin`;
  await mkdir(dirname(join(stage, file)), { recursive: true });
  await writeFile(join(stage, file), content);
  objects.push({ key, file, contentType, size: content.byteLength, sha256: sha256(content) });
}

async function writeSqlChunk(stage, index, statements) {
  const file = `d1/${String(index).padStart(6, '0')}.sql`;
  const content = Buffer.from(statements.join('\n\n') + '\n');
  await writeFile(join(stage, file), content);
  return { file, size: content.byteLength, sha256: sha256(content) };
}

async function readJsonLines(path) {
  const text = await readFile(path, 'utf8');
  return text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

async function readState(path, target) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    return {
      nextObject: Number.isSafeInteger(state.nextObject) ? state.nextObject : 0,
      nextSql: Number.isSafeInteger(state.nextSql) ? state.nextSql : 0,
      target,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { nextObject: 0, nextSql: 0, target };
    throw error;
  }
}

async function writeState(path, state) {
  await writeFile(path, JSON.stringify(state, null, 2) + '\n');
}

function runWrangler(args, io) {
  const result = io.spawn('npx', ['--no-install', 'wrangler', ...args], {
    cwd: process.cwd(), stdio: 'inherit', shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wrangler failed with exit ${result.status}`);
}

function targetFlag(options) {
  if (Boolean(options.local) === Boolean(options.remote)) {
    throw new Error('specify exactly one of local or remote');
  }
  return options.local ? '--local' : '--remote';
}

function persistenceArgs(options) {
  return options.persistTo ? ['--persist-to', options.persistTo] : [];
}

async function assertMissing(path) {
  try {
    await access(path);
    throw new Error(`stage already exists: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
