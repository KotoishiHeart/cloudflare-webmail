import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { extractActiveVersion, validateRollbackPlan } from './deploy-rollback.mjs';

const APPS = ['jobs', 'ingest', 'web'];
const REQUIRED_TABLES = [
  'access_identities', 'attachments', 'audit_events', 'delivery_events',
  'inbound_handoffs', 'legacy_migration_delta_sources', 'legacy_migration_deltas',
  'mail_rule_labels', 'mail_rule_run_matches', 'mail_rule_runs',
  'mail_rules', 'mailbox_addresses', 'mailbox_labels', 'mailbox_memberships',
  'mailboxes', 'maintenance_cursors', 'message_labels', 'message_migration_sources',
  'message_search_documents', 'messages', 'migration_batches',
  'migration_configuration_sources', 'outbound_compositions',
  'outbound_deliveries', 'outbound_recipients', 'queue_dead_letters',
  'retention_policies', 'retention_run_items', 'retention_runs', 'storage_issues',
  'system_administrators', 'user_preferences', 'users',
];

const READINESS_SQL = `
  SELECT
    (SELECT GROUP_CONCAT(name, ',') FROM (
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    )) AS table_names,
    (SELECT COUNT(*) FROM inbound_handoffs WHERE status <> 'stored') AS inbound_unresolved,
    (SELECT COUNT(*) FROM outbound_deliveries WHERE status <> 'sent') AS outbound_unresolved,
    (SELECT COUNT(*) FROM queue_dead_letters WHERE status <> 'resolved') AS dead_letters_unresolved,
    (SELECT COUNT(*) FROM storage_issues WHERE status = 'open') AS storage_issues_open,
    (SELECT COUNT(*) FROM retention_runs
      WHERE status IN ('building', 'approved', 'running', 'failed')) AS retention_unresolved
`;

export async function runDeployPostflight(
  stage,
  plan,
  deployResult,
  rollback,
  options = {},
  client = defaultClient(),
) {
  validateDeployResult(plan, deployResult);
  validateRollbackPlan(plan, rollback);
  const checks = [];
  const activeVersions = [];
  for (const app of APPS) {
    const descriptor = configDescriptor(plan, app);
    const output = check(client, [
      'deployments', 'status', '--json', '--config', join(stage, descriptor.file),
    ], options, checks, `deployment:${app}`);
    const versionId = extractActiveVersion(output);
    const previous = rollback.workers.find((item) => item.app === app)?.versionId;
    if (previous === versionId) throw new Error(`${app} is still on its pre-deploy Worker version`);
    activeVersions.push({ app, worker: descriptor.worker, versionId });
  }

  const webConfig = join(stage, configDescriptor(plan, 'web').file);
  const readinessOutput = check(client, [
    'd1', 'execute', plan.deployment.resources.d1.name, '--remote',
    '--command', READINESS_SQL, '--json', '--config', webConfig,
  ], options, checks, 'd1-readiness');
  const operational = parseReadiness(readinessOutput);
  await checkHealth(plan, options, client);
  checks.push('web-health');

  const blockers = Object.entries(operational)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => ({ name, count }));
  return {
    version: 1,
    kind: 'cf-webmail-deploy-postflight',
    planId: plan.planId,
    completedAt: Date.now(),
    checks,
    activeVersions,
    requiredTableCount: REQUIRED_TABLES.length,
    operational,
    cutoverReady: blockers.length === 0,
    blockers,
    manualChecks: [
      'Cloudflare Access interactive login and system-admin boundary',
      'Dedicated canary inbound message persisted with body and attachments',
      'Dedicated canary outbound message delivered with SPF, DKIM, and DMARC alignment',
      'Email Routing production rule remains unchanged until cutover approval',
    ],
  };
}

function validateDeployResult(plan, result) {
  if (result?.version !== 1 || result?.kind !== 'cf-webmail-deploy-result') {
    throw new Error('deployment result is invalid');
  }
  if (result.planId !== plan.planId) throw new Error('deployment result belongs to another stage');
  const expected = ['migrate', 'deploy:jobs', 'deploy:ingest', 'deploy:web'];
  if (JSON.stringify(result.steps) !== JSON.stringify(expected)) {
    throw new Error('deployment result does not contain every apply step');
  }
}

function parseReadiness(output) {
  const payload = parseJson(output);
  const rows = Array.isArray(payload)
    ? payload.flatMap((item) => item?.results ?? [])
    : payload?.results ?? [];
  const row = rows[0];
  if (typeof row !== 'object' || row === null) throw new Error('D1 readiness query returned no row');
  const present = new Set(String(row.table_names ?? '').split(',').filter(Boolean));
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) throw new Error(`D1 is missing required table: ${missing[0]}`);
  return {
    inboundUnresolved: count(row.inbound_unresolved, 'inbound_unresolved'),
    outboundUnresolved: count(row.outbound_unresolved, 'outbound_unresolved'),
    deadLettersUnresolved: count(row.dead_letters_unresolved, 'dead_letters_unresolved'),
    storageIssuesOpen: count(row.storage_issues_open, 'storage_issues_open'),
    retentionUnresolved: count(row.retention_unresolved, 'retention_unresolved'),
  };
}

async function checkHealth(plan, options, client) {
  const clientId = options.accessClientId ?? process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = options.accessClientSecret ?? process.env.CF_ACCESS_CLIENT_SECRET;
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error('set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET or neither');
  }
  const headers = clientId
    ? { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret }
    : {};
  const response = await client.fetch(`https://${plan.deployment.hostname}/healthz`, {
    headers,
    redirect: 'manual',
  });
  if (!response.ok) throw new Error(`web health check failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.ok !== true || payload.service !== 'cf-webmail-web' || payload.architectureVersion !== 1) {
    throw new Error('web health response does not match this architecture');
  }
}

function check(client, args, options, checks, name) {
  const profile = options.profile ? ['--profile', options.profile] : [];
  const result = client.spawn('npx', ['--no-install', 'wrangler', ...args, ...profile], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
    env: { ...process.env, WRANGLER_LOG_PATH: '/tmp/cf-webmail-wrangler.log' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(`${name} failed with exit ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  checks.push(name);
  return String(result.stdout ?? '');
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

function count(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid D1 readiness count: ${name}`);
  return number;
}

function configDescriptor(plan, app) {
  const descriptor = plan.configs.find((item) => item.app === app);
  if (!descriptor) throw new Error(`deployment plan has no ${app} config`);
  return descriptor;
}

function defaultClient() {
  return { spawn: spawnSync, fetch: globalThis.fetch };
}
