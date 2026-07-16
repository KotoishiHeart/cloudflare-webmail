import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CAPTURE_ORDER = ['jobs', 'ingest', 'web'];
const ROLLBACK_ORDER = ['web', 'ingest', 'jobs'];
const VERSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export async function createRollbackPlan(stage, plan, options = {}, runner = defaultRunner()) {
  if (plan.deployment.mode === 'initial') {
    return {
      version: 1,
      kind: 'cf-webmail-rollback-plan',
      planId: plan.planId,
      sourceCommit: plan.source.commit,
      createdAt: Date.now(),
      available: false,
      reason: 'initial deployment has no previous Worker versions',
      workers: [],
      dataRollback: 'restore a verified backup into new D1 and R2 resources',
    };
  }

  const workers = [];
  for (const app of CAPTURE_ORDER) {
    const descriptor = configDescriptor(plan, app);
    const result = spawnWrangler(runner, [
      'deployments', 'status', '--json', '--config', join(stage, descriptor.file),
    ], options, 'pipe');
    if (result.status !== 0) throw failure(`capture:${app}`, result);
    workers.push({
      app,
      worker: descriptor.worker,
      configFile: descriptor.file,
      configSha256: descriptor.sha256,
      versionId: extractActiveVersion(String(result.stdout ?? '')),
    });
  }
  return {
    version: 1,
    kind: 'cf-webmail-rollback-plan',
    planId: plan.planId,
    sourceCommit: plan.source.commit,
    createdAt: Date.now(),
    available: true,
    workers,
    dataRollback: 'restore a verified backup into new D1 and R2 resources',
  };
}

export function validateRollbackPlan(plan, rollback) {
  if (rollback?.version !== 1 || rollback?.kind !== 'cf-webmail-rollback-plan') {
    throw new Error('rollback plan is invalid');
  }
  if (rollback.planId !== plan.planId || rollback.sourceCommit !== plan.source.commit) {
    throw new Error('rollback plan belongs to another deployment stage');
  }
  if (plan.deployment.mode === 'initial') {
    if (rollback.available !== false || rollback.workers?.length !== 0) {
      throw new Error('initial deployment rollback plan must not contain Worker versions');
    }
    return rollback;
  }
  if (rollback.available !== true || rollback.workers?.length !== CAPTURE_ORDER.length) {
    throw new Error('upgrade rollback plan is incomplete');
  }
  for (const app of CAPTURE_ORDER) {
    const expected = configDescriptor(plan, app);
    const worker = rollback.workers.find((item) => item?.app === app);
    if (
      worker?.worker !== expected.worker
      || worker.configFile !== expected.file
      || worker.configSha256 !== expected.sha256
      || !VERSION_ID.test(worker.versionId ?? '')
    ) throw new Error(`rollback plan has invalid ${app} Worker state`);
  }
  return rollback;
}

export function runRollbackApply(stage, plan, rollback, options = {}, runner = defaultRunner()) {
  validateRollbackPlan(plan, rollback);
  if (!rollback.available) throw new Error('initial deployment has no previous Worker versions to roll back');
  const reason = validateReason(options.reason);
  const steps = [];
  for (const app of ROLLBACK_ORDER) {
    const worker = rollback.workers.find((item) => item.app === app);
    const result = spawnWrangler(runner, [
      'rollback', worker.versionId,
      '--message', `cf-webmail ${rollback.planId.slice(0, 12)}: ${reason}`,
      '--config', join(stage, worker.configFile),
    ], options, 'inherit');
    if (result.status !== 0) throw failure(`rollback:${app}`, result);
    steps.push(`rollback:${app}`);
  }
  return {
    version: 1,
    kind: 'cf-webmail-rollback-result',
    planId: plan.planId,
    completedAt: Date.now(),
    reason,
    steps,
    databaseRolledBack: false,
    objectStorageRolledBack: false,
  };
}

export function extractActiveVersion(output) {
  const payload = parseJson(output);
  const candidates = [];
  visit(payload, candidates);
  const explicit = candidates.filter((candidate) => candidate.percentage === 100);
  const active = explicit.length === 1
    ? explicit[0]
    : candidates.length === 1 && candidates[0].percentage === undefined
      ? candidates[0]
      : undefined;
  if (!active || !VERSION_ID.test(active.id)) {
    throw new Error('Worker must have exactly one active version receiving 100% of traffic');
  }
  const otherTraffic = candidates.some((candidate) => candidate !== active && (candidate.percentage ?? 0) > 0);
  if (otherTraffic) throw new Error('split-traffic deployments cannot be captured as one rollback version');
  return active.id;
}

function visit(value, candidates) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, candidates);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const id = value.version_id ?? value.versionId;
  if (typeof id === 'string') {
    const rawPercentage = value.percentage ?? value.traffic_percentage ?? value.trafficPercentage;
    const percentage = rawPercentage === undefined ? undefined : Number(rawPercentage);
    candidates.push({ id: id.toLowerCase(), percentage: Number.isFinite(percentage) ? percentage : undefined });
  }
  for (const child of Object.values(value)) visit(child, candidates);
}

function parseJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    const starts = [output.indexOf('{'), output.indexOf('[')].filter((index) => index >= 0);
    const start = Math.min(...starts);
    if (!Number.isFinite(start)) throw new Error('Wrangler did not return deployment JSON');
    return JSON.parse(output.slice(start));
  }
}

function validateReason(value) {
  if (typeof value !== 'string' || value.trim().length < 4 || value.trim().length > 160 || /[\r\n]/u.test(value)) {
    throw new Error('--reason must contain 4 to 160 characters on one line');
  }
  return value.trim();
}

function configDescriptor(plan, app) {
  const descriptor = plan.configs.find((item) => item.app === app);
  if (!descriptor) throw new Error(`deployment plan has no ${app} config`);
  return descriptor;
}

function spawnWrangler(runner, args, options, stdio) {
  const profile = options.profile ? ['--profile', options.profile] : [];
  const result = runner.spawn('npx', ['--no-install', 'wrangler', ...args, ...profile], {
    cwd: process.cwd(),
    encoding: stdio === 'pipe' ? 'utf8' : undefined,
    stdio,
    shell: false,
    env: { ...process.env, WRANGLER_LOG_PATH: '/tmp/cf-webmail-wrangler.log' },
  });
  if (result.error) throw result.error;
  return result;
}

function failure(name, result) {
  const detail = String(result.stderr ?? '').trim();
  return new Error(`${name} failed with exit ${result.status}${detail ? `: ${detail}` : ''}`);
}

function defaultRunner() {
  return { spawn: spawnSync };
}
