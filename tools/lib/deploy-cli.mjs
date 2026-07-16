import { spawnSync } from 'node:child_process';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseOptions } from './ops-cli.mjs';
import { verifyBackup } from './backup-core.mjs';
import { runDeployApply, runDeployPreflight } from './deploy-cloudflare.mjs';
import {
  createRollbackPlan,
  runRollbackApply,
  validateRollbackPlan,
} from './deploy-rollback.mjs';
import { createDeployStage, verifyDeployStage } from './deploy-stage.mjs';

export async function runDeployCli(argv, io = defaultIo()) {
  const [command = 'help', ...args] = argv;
  const options = parseOptions(args);
  if (command === 'help' || options.help) {
    io.stdout(usage());
    return 0;
  }
  if (command === 'plan') {
    const repository = repositoryState(io);
    if (repository.dirty) throw new Error('deployment plans require a clean Git worktree');
    const input = JSON.parse(await readFile(resolve(required(options, 'manifest')), 'utf8'));
    const plan = await createDeployStage(required(options, 'stage'), input, repository);
    io.stdout(`${JSON.stringify(summary(plan), null, 2)}\n`);
    return 0;
  }

  const stage = resolve(required(options, 'stage'));
  if (command === 'rollback') {
    if (!options.yes) throw new Error('rollback changes deployed Workers; pass --yes after review');
    const plan = await verifyDeployStage(stage);
    const rollback = validateRollbackPlan(
      plan,
      JSON.parse(await readFile(join(stage, 'rollback-plan.json'), 'utf8')),
    );
    const output = join(stage, 'rollback-result.json');
    await requireOutputAbsent(output);
    const result = runRollbackApply(
      stage,
      plan,
      rollback,
      { profile: options.profile, reason: options.reason },
      io,
    );
    await writeJsonAtomic(output, result, false);
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const repository = repositoryState(io);
  if (repository.dirty) throw new Error('deployment commands require a clean Git worktree');
  const plan = await verifyDeployStage(stage, repository);
  if (command === 'verify') {
    io.stdout(`${JSON.stringify(summary(plan), null, 2)}\n`);
    return 0;
  }
  if (command === 'preflight') {
    const output = join(stage, 'preflight.json');
    if (!options.force) await requireOutputAbsent(output);
    const report = await runDeployPreflight(stage, plan, { profile: options.profile }, io);
    await writeJsonAtomic(output, report, Boolean(options.force));
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  if (command === 'deploy') {
    if (!options.yes) throw new Error('deploy changes remote D1 and Workers; pass --yes after review');
    const output = join(stage, 'deploy-result.json');
    await requireOutputAbsent(output);
    const preflight = JSON.parse(await readFile(join(stage, 'preflight.json'), 'utf8'));
    if (plan.deployment.mode === 'upgrade') {
      const backup = required(options, 'backup');
      const backupManifest = await verifyBackup(backup);
      assertBackupTarget(stage, plan, backupManifest);
    }
    const rollback = await loadOrCreateRollbackPlan(stage, plan, { profile: options.profile }, io);
    const result = runDeployApply(stage, plan, preflight, { profile: options.profile }, io);
    result.rollbackPlan = 'rollback-plan.json';
    result.rollbackAvailable = rollback.available;
    await writeJsonAtomic(output, result, false);
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}

async function loadOrCreateRollbackPlan(stage, plan, options, io) {
  const output = join(stage, 'rollback-plan.json');
  try {
    const existing = JSON.parse(await readFile(output, 'utf8'));
    return validateRollbackPlan(plan, existing);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const rollback = await createRollbackPlan(stage, plan, options, io);
  validateRollbackPlan(plan, rollback);
  await writeJsonAtomic(output, rollback, false);
  return rollback;
}

export function assertBackupTarget(stage, plan, backup) {
  const webConfig = plan.configs.find((item) => item.app === 'web');
  const expectedConfig = webConfig ? resolve(stage, webConfig.file) : '';
  if (
    backup?.source?.mode !== 'remote'
    || backup.source.database !== plan.deployment.resources.d1.name
    || backup.source.bucket !== plan.deployment.resources.r2.bucket
    || resolve(backup.source.config ?? '') !== expectedConfig
  ) throw new Error('backup source does not match the deployment D1 and R2 target');
}

function repositoryState(io) {
  const root = git(io, ['rev-parse', '--show-toplevel']).trim();
  const commit = git(io, ['rev-parse', 'HEAD']).trim().toLowerCase();
  const status = git(io, ['status', '--porcelain']).trim();
  return { root, commit, dirty: status !== '' };
}

function git(io, args) {
  const result = io.spawn('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return String(result.stdout ?? '');
}

function summary(plan) {
  return {
    planId: plan.planId,
    environment: plan.deployment.environment,
    mode: plan.deployment.mode,
    hostname: plan.deployment.hostname,
    sourceCommit: plan.source.commit,
    workers: plan.configs.map((config) => config.worker),
  };
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value === '') throw new Error(`--${key} is required`);
  return value;
}

async function writeJsonAtomic(path, value, overwrite) {
  const temporary = `${path}.partial`;
  if (!overwrite) {
    await readFile(path).then(
      () => { throw new Error(`output already exists: ${path}`); },
      (error) => { if (error?.code !== 'ENOENT') throw error; },
    );
  }
  await unlink(temporary).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, path);
}

async function requireOutputAbsent(path) {
  await readFile(path).then(
    () => { throw new Error(`output already exists: ${path}`); },
    (error) => { if (error?.code !== 'ENOENT') throw error; },
  );
}

function defaultIo() {
  return { stdout: (value) => process.stdout.write(value), spawn: spawnSync };
}

function usage() {
  return `Cloudflare Webmail deployment\n\n` +
    `  plan --manifest FILE --stage DIR\n` +
    `  verify --stage DIR\n` +
    `  preflight --stage DIR [--profile NAME] [--force]\n` +
    `  deploy --stage DIR --yes [--backup DIR] [--profile NAME]\n` +
    `  rollback --stage DIR --reason TEXT --yes [--profile NAME]\n\n` +
    `Upgrade mode requires a verified backup. The tool never creates resources or Email Routing rules.\n`;
}
