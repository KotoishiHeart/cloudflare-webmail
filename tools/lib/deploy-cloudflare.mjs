import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyQueueTopology } from './deploy-queue-topology.mjs';

const EMPTY_DATABASE_SQL = `
  SELECT COUNT(*) AS table_count
  FROM sqlite_master
  WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%'
    AND name NOT LIKE '_cf_%'
`;

export async function runDeployPreflight(stage, plan, options = {}, runner = defaultRunner()) {
  const webConfig = configPath(stage, plan, 'web');
  const jobsConfig = configPath(stage, plan, 'jobs');
  const ingestConfig = configPath(stage, plan, 'ingest');
  const checks = [];
  check(runner, ['whoami'], { ...options, profile: undefined }, checks, 'wrangler-auth');

  const d1Output = check(runner, [
    'd1', 'info', plan.deployment.resources.d1.name, '--json', '--config', webConfig,
  ], options, checks, 'd1');
  assertD1Identity(d1Output, plan.deployment.resources.d1);
  const r2Output = check(runner, [
    'r2', 'bucket', 'info', plan.deployment.resources.r2.bucket, '--json', '--config', webConfig,
  ], options, checks, 'r2');
  assertR2Identity(r2Output, plan.deployment.resources.r2.bucket);

  const queueTopologies = [];
  for (const [role, queue] of Object.entries(plan.deployment.resources.queues)) {
    const output = check(
      runner,
      ['queues', 'info', queue, '--config', jobsConfig],
      options,
      checks,
      `queue:${queue}`,
    );
    queueTopologies.push({ role, ...verifyQueueTopology(output, role, plan.deployment) });
  }
  checks.push(`outbound-provider:${plan.deployment.email.outboundProvider}`);
  for (const domain of plan.deployment.email.routingDomains) {
    const output = check(
      runner,
      ['email', 'routing', 'settings', domain, '--config', ingestConfig],
      options,
      checks,
      `email-routing:${domain}`,
    );
    if (!/^\s*Enabled:\s+true\s*$/imu.test(output)) {
      throw new Error(`Email Routing is not enabled for ${domain}`);
    }
  }

  const databaseOutput = check(runner, [
    'd1', 'execute', plan.deployment.resources.d1.name, '--remote',
    '--command', EMPTY_DATABASE_SQL, '--json', '--config', webConfig,
  ], options, checks, 'd1-table-count');
  const tableCount = extractTableCount(databaseOutput);

  const dryRunDirectory = join(stage, 'dry-run');
  await mkdir(dryRunDirectory, { recursive: true });
  for (const app of ['jobs', 'ingest', 'web']) {
    check(runner, [
      'deploy', '--dry-run', '--config', configPath(stage, plan, app),
      '--outdir', join(dryRunDirectory, app),
    ], options, checks, `dry-run:${app}`);
  }
  return {
    version: 1,
    kind: 'cf-webmail-deploy-preflight',
    planId: plan.planId,
    completedAt: Date.now(),
    tableCount,
    databaseEmpty: tableCount === 0,
    queueTopologies,
    checks,
    manualChecks: [
      'Access application hostname and Allow policy',
      'Email Routing rule targets the ingest Worker',
      'SMTP2GO sender domains, API key permission, and free-plan quota',
      'SPF, DKIM, and DMARC alignment in SMTP2GO',
    ],
  };
}

export function runDeployApply(stage, plan, preflight, options = {}, runner = defaultRunner()) {
  validatePreflight(plan, preflight);
  const checks = [];
  const webConfig = configPath(stage, plan, 'web');
  mutate(runner, [
    'd1', 'migrations', 'apply', plan.deployment.resources.d1.name,
    '--remote', '--config', webConfig,
  ], options, checks, 'migrate');
  for (const app of ['jobs', 'ingest', 'web']) {
    const secretArguments = app === 'jobs'
      ? ['--secrets-file', requiredSecretsFile(options)]
      : [];
    mutate(
      runner,
      ['deploy', '--config', configPath(stage, plan, app), ...secretArguments],
      options,
      checks,
      `deploy:${app}`,
    );
  }
  return {
    version: 1,
    kind: 'cf-webmail-deploy-result',
    planId: plan.planId,
    completedAt: Date.now(),
    steps: checks,
    routingEnabled: false,
  };
}

function validatePreflight(plan, preflight) {
  if (preflight?.version !== 1 || preflight?.kind !== 'cf-webmail-deploy-preflight') {
    throw new Error('deployment preflight report is invalid');
  }
  if (preflight.planId !== plan.planId) throw new Error('preflight belongs to another deployment plan');
  const age = Date.now() - preflight.completedAt;
  if (!Number.isSafeInteger(preflight.completedAt) || age < -5 * 60 * 1000 || age > 60 * 60 * 1000) {
    throw new Error('preflight is older than one hour; run it again');
  }
  if (!Array.isArray(preflight.checks) || preflight.checks.length < 10) {
    throw new Error('deployment preflight report is incomplete');
  }
  if (plan.deployment.mode === 'initial' && preflight.databaseEmpty !== true) {
    throw new Error('initial deployment requires an empty D1 database');
  }
}

function assertD1Identity(output, expected) {
  const payload = parseJson(output);
  const id = payload.uuid ?? payload.id ?? payload.database_id;
  const name = payload.name ?? payload.database_name;
  if (id !== expected.id || name !== expected.name) {
    throw new Error('remote D1 identity does not match the deployment manifest');
  }
}

function assertR2Identity(output, expected) {
  const payload = parseJson(output);
  const name = payload.name ?? payload.bucket_name ?? payload.bucket;
  if (name !== expected) throw new Error('remote R2 bucket does not match the deployment manifest');
}

function extractTableCount(output) {
  const payload = parseJson(output);
  const rows = Array.isArray(payload)
    ? payload.flatMap((item) => item?.results ?? [])
    : payload?.results ?? [];
  const count = Number(rows[0]?.table_count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('could not determine remote D1 table count');
  return count;
}

function parseJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    const starts = [output.indexOf('{'), output.indexOf('[')].filter((index) => index >= 0);
    const start = Math.min(...starts);
    if (!Number.isFinite(start)) throw new Error('Wrangler did not return JSON');
    return JSON.parse(output.slice(start));
  }
}

function check(runner, args, options, checks, name) {
  const result = spawn(runner, args, options, 'pipe');
  if (result.status !== 0) throw failure(name, result);
  checks.push(name);
  return String(result.stdout ?? '');
}

function mutate(runner, args, options, checks, name) {
  const result = spawn(runner, args, options, 'inherit');
  if (result.status !== 0) throw failure(name, result);
  checks.push(name);
}

function spawn(runner, args, options, stdio) {
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

function configPath(stage, plan, app) {
  const descriptor = plan.configs.find((item) => item.app === app);
  if (!descriptor) throw new Error(`deployment plan has no ${app} config`);
  return join(stage, descriptor.file);
}

function requiredSecretsFile(options) {
  if (typeof options.secretsFile !== 'string' || options.secretsFile === '') {
    throw new Error('deploy requires a validated SMTP2GO secrets file');
  }
  return options.secretsFile;
}

function defaultRunner() {
  return { spawn: spawnSync };
}
