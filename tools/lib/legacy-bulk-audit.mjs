import { createHash } from 'node:crypto';
import { chmod, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultRunner } from './backup-cloudflare.mjs';
import { auditLegacyTarget } from './legacy-bulk-apply.mjs';
import { materializeLegacyR2Tree } from './legacy-bulk-stage.mjs';

export async function auditLegacyStageBulk(stageInput, options, runner = defaultRunner()) {
  if (Boolean(options.local) === Boolean(options.remote)) {
    throw new Error('specify exactly one of --local or --remote');
  }
  if (options.remote && options.persistTo) throw new Error('--persist-to is local-only');
  const stage = resolve(stageInput);
  const tree = await materializeLegacyR2Tree(stage, options.tree);
  const destination = rcloneDestination(options.rcloneDestination);
  const report = resolve(options.report);
  await requireAbsent(report);
  const checkers = integer(options.checkers ?? 32, 1, 128, 'checkers');
  run(runner, 'rclone', ['version']);
  run(runner, 'rclone', [
    'check', tree.output, destination, '--download', '--one-way', '--fast-list',
    '--checkers', String(checkers), '--combined', report,
    ...rcloneConfigArgs(options),
  ]);
  await chmod(report, 0o600);
  const reportInfo = await stat(report);
  const d1 = auditLegacyTarget(tree.manifest, options, runner);
  return {
    version: 1,
    kind: 'cf-webmail-legacy-cutover-audit',
    createdAt: Date.now(),
    stageSha256: tree.stageSha256,
    batchId: tree.batchId,
    target: {
      mode: options.local ? 'local' : 'remote',
      database: options.database,
      rcloneDestination: destination,
    },
    r2: {
      objects: tree.objects,
      report,
      reportSize: reportInfo.size,
      reportSha256: sha256(await readFile(report)),
    },
    d1,
  };
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

function integer(value, minimum, maximum, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

async function requireAbsent(path) {
  await readFile(path).then(
    () => { throw new Error(`output already exists: ${path}`); },
    (error) => { if (error?.code !== 'ENOENT') throw error; },
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
