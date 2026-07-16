import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultRunner, queryD1 } from './backup-cloudflare.mjs';
import { materializeLegacyR2Tree } from './legacy-bulk-stage.mjs';

export async function applyLegacyStageBulk(stageInput, options, runner = defaultRunner()) {
  if (!options.yes) throw new Error('bulk apply changes R2 and D1; pass --yes after verification');
  if (Boolean(options.local) === Boolean(options.remote)) {
    throw new Error('specify exactly one of --local or --remote');
  }
  if (options.remote && options.persistTo) throw new Error('--persist-to is local-only');
  const destination = rcloneDestination(options.rcloneDestination);
  const transfers = integer(options.transfers ?? 16, 1, 64, 'transfers');
  const checkers = integer(options.checkers ?? 32, 1, 128, 'checkers');
  const stage = resolve(stageInput);
  const tree = await materializeLegacyR2Tree(stage, options.tree ?? join(stage, 'r2-upload'));
  const target = {
    mode: options.local ? 'local' : 'remote',
    database: options.database,
    config: resolve(options.config),
    persistTo: options.persistTo === undefined ? null : resolve(options.persistTo),
    rcloneDestination: destination,
    rcloneConfig: options.rcloneConfig === undefined ? null : resolve(options.rcloneConfig),
  };
  const targetId = sha256(Buffer.from(JSON.stringify(target))).slice(0, 16);
  const statePath = join(stage, `bulk-apply-state.${targetId}.json`);
  const state = await readState(
    statePath,
    target,
    tree.stageSha256,
    tree.manifest.sqlFiles.length,
  );
  if (state.completedAt !== null) return state;
  run(runner, 'rclone', ['version']);
  if (!state.r2Copied) {
    run(runner, 'rclone', [
      'copy', tree.output, destination, '--checksum', '--immutable', '--fast-list',
      '--transfers', String(transfers), '--checkers', String(checkers),
      ...rcloneConfigArgs(options),
    ]);
    state.r2Copied = true;
    await writeState(statePath, state);
  }
  const report = join(stage, `rclone-check.${targetId}.txt`);
  if (!state.r2Verified) {
    await rm(report, { force: true });
    run(runner, 'rclone', [
      'check', tree.output, destination, '--download', '--one-way', '--fast-list',
      '--checkers', String(checkers), '--combined', report,
      ...rcloneConfigArgs(options),
    ]);
    const reportInfo = await stat(report);
    state.r2Verified = true;
    state.r2Report = {
      file: report,
      size: reportInfo.size,
      sha256: sha256(await readFile(report)),
    };
    await writeState(statePath, state);
  }
  for (let index = state.nextSql; index < tree.manifest.sqlFiles.length; index += 1) {
    const sqlFile = tree.manifest.sqlFiles[index];
    run(runner, 'npx', [
      '--no-install', 'wrangler', 'd1', 'execute', options.database, targetFlag(options),
      ...persistenceArgs(options), '--file', join(stage, sqlFile.file),
      '--yes', '--config', options.config,
    ]);
    state.nextSql = index + 1;
    await writeState(statePath, state);
  }
  state.d1Audit = auditLegacyTarget(tree.manifest, options, runner);
  state.completedAt = Date.now();
  await writeState(statePath, state);
  return state;
}

export function auditLegacyTarget(manifest, options, runner) {
  const batchRows = queryD1(`
    SELECT b.source_database_sha256, b.mapping_sha256, b.snapshot_sha256,
      b.expected_messages, b.source_objects, b.staged_objects,
      (SELECT COUNT(*) FROM message_migration_sources AS s WHERE s.batch_id = b.id) AS imported_messages,
      (SELECT COALESCE(SUM(1 + (m.body_text_key IS NOT NULL) + (m.body_html_key IS NOT NULL)
        + m.attachment_count), 0)
       FROM message_migration_sources AS s JOIN messages AS m ON m.id = s.message_id
       WHERE s.batch_id = b.id) AS object_references,
      (SELECT COALESCE(SUM(m.status = 'quarantined'), 0)
       FROM message_migration_sources AS s JOIN messages AS m ON m.id = s.message_id
       WHERE s.batch_id = b.id) AS quarantined
    FROM migration_batches AS b WHERE b.id = '${manifest.batchId}'
  `, options, runner);
  if (batchRows.length !== 1) throw new Error('target D1 migration batch was not found exactly once');
  const batch = batchRows[0];
  for (const [field, expected] of [
    ['source_database_sha256', manifest.sourceDatabaseSha256],
    ['mapping_sha256', manifest.mappingSha256],
    ['snapshot_sha256', manifest.snapshotSha256],
    ['expected_messages', manifest.counts.prepared],
    ['source_objects', manifest.counts.sourceObjects],
    ['staged_objects', manifest.counts.objects],
    ['imported_messages', manifest.counts.prepared],
    ['object_references', manifest.counts.objects],
    ['quarantined', manifest.counts.quarantined],
  ]) {
    if (String(batch[field]) !== String(expected)) {
      throw new Error(`target D1 migration batch mismatch: ${field}`);
    }
  }
  const accountRows = queryD1(`
    SELECT s.source_account,
      COUNT(*) AS prepared,
      SUM(m.direction = 'inbound') AS inbound,
      SUM(m.direction = 'outbound') AS outbound,
      SUM(m.is_read) AS read_count,
      SUM(m.is_starred) AS starred,
      SUM(m.is_archived) AS archived,
      SUM(m.is_deleted) AS deleted,
      SUM(m.attachment_count) AS attachments
    FROM message_migration_sources AS s JOIN messages AS m ON m.id = s.message_id
    WHERE s.batch_id = '${manifest.batchId}' GROUP BY s.source_account
  `, options, runner);
  const actual = new Map(accountRows.map((row) => [String(row.source_account), row]));
  for (const expected of manifest.mappings) {
    const row = actual.get(expected.sourceAddress);
    for (const [field, expectedValue] of [
      ['prepared', expected.prepared], ['inbound', expected.inbound],
      ['outbound', expected.outbound], ['read_count', expected.read],
      ['starred', expected.starred], ['archived', expected.archived],
      ['deleted', expected.deleted], ['attachments', expected.attachments],
    ]) {
      if (Number(row?.[field] ?? 0) !== expectedValue) {
        throw new Error(`target D1 account mismatch: ${expected.sourceAddress} ${field}`);
      }
    }
    actual.delete(expected.sourceAddress);
  }
  if (actual.size !== 0) throw new Error('target D1 contains unexpected migration source accounts');
  return { batchId: manifest.batchId, messages: manifest.counts.prepared, objects: manifest.counts.objects };
}

function run(runner, command, args) {
  const result = runner.spawn(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
    env: { ...process.env, WRANGLER_LOG_PATH: '/tmp/cf-webmail-wrangler.log' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit ${result.status}: ${String(result.stderr ?? '').slice(0, 1000)}`);
  }
}

async function readState(path, target, stageSha256, sqlFileCount) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (JSON.stringify(state.target) !== JSON.stringify(target) || state.stageSha256 !== stageSha256) {
      throw new Error('bulk apply state belongs to a different stage or target');
    }
    if (
      typeof state.r2Copied !== 'boolean'
      || typeof state.r2Verified !== 'boolean'
      || !Number.isSafeInteger(state.nextSql)
      || state.nextSql < 0
      || state.nextSql > sqlFileCount
      || (state.completedAt !== null && (!Number.isSafeInteger(state.completedAt) || state.completedAt < 1))
    ) throw new Error('bulk apply state is invalid');
    return state;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return {
      target,
      stageSha256,
      r2Copied: false,
      r2Verified: false,
      r2Report: null,
      nextSql: 0,
      d1Audit: null,
      completedAt: null,
    };
  }
}

async function writeState(path, state) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

function rcloneDestination(value) {
  const normalized = String(value ?? '').trim().replace(/\/$/u, '');
  if (!/^[A-Za-z0-9_.-]+:[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(normalized)) {
    throw new Error('--rclone-destination must be a named remote and bucket root (REMOTE:BUCKET)');
  }
  return normalized;
}

function rcloneConfigArgs(options) {
  return options.rcloneConfig === undefined ? [] : ['--config', resolve(options.rcloneConfig)];
}

function targetFlag(options) {
  return options.local ? '--local' : '--remote';
}

function persistenceArgs(options) {
  return options.persistTo ? ['--persist-to', options.persistTo] : [];
}

function integer(value, minimum, maximum, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
