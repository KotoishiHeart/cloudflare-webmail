import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDeployPostflight } from '../lib/deploy-postflight.mjs';
import { createRollbackPlan } from '../lib/deploy-rollback.mjs';
import { createDeployStage } from '../lib/deploy-stage.mjs';

const COMMIT = 'd'.repeat(40);
const VERSION = '99999999-9999-4999-8999-999999999999';
const TABLES = [
  'access_identities', 'attachments', 'audit_events', 'delivery_events',
  'inbound_handoffs', 'mail_rule_labels', 'mail_rule_run_matches', 'mail_rule_runs',
  'mail_rules', 'mailbox_addresses', 'mailbox_labels', 'mailbox_memberships',
  'mailboxes', 'maintenance_cursors', 'message_labels', 'message_migration_sources',
  'message_search_documents', 'messages', 'migration_batches', 'outbound_compositions',
  'outbound_deliveries', 'outbound_recipients', 'queue_dead_letters',
  'retention_policies', 'retention_run_items', 'retention_runs', 'storage_issues',
  'system_administrators', 'user_preferences', 'users',
];
const MANIFEST = {
  version: 1, environment: 'production', mode: 'upgrade', accountId: 'a'.repeat(32),
  hostname: 'mail.example.com',
  workers: { web: 'cf-webmail-web', ingest: 'cf-webmail-ingest', jobs: 'cf-webmail-jobs' },
  access: { teamDomain: 'https://example.cloudflareaccess.com', audience: 'b'.repeat(64) },
  resources: {
    d1: { name: 'cf-webmail', id: '11111111-1111-4111-8111-111111111111' },
    r2: { bucket: 'cf-webmail-raw' },
    queues: {
      inbound: 'cf-webmail-inbound', inboundDlq: 'cf-webmail-inbound-dlq',
      outbound: 'cf-webmail-outbound', outboundDlq: 'cf-webmail-outbound-dlq',
    },
  },
  email: { sendingDomains: ['example.com'], routingDomains: ['example.com'] },
  limits: { queueMaxConcurrency: 1 },
};

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cf-webmail-postflight-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('production postflight', () => {
  it('verifies new Worker versions, schema, health, and an empty cutover gate', async () => {
    const { stage, plan, rollback, deployResult } = await fixture('ready');
    const calls = [];
    const report = await runDeployPostflight(
      stage,
      plan,
      deployResult,
      rollback,
      { accessClientId: 'id', accessClientSecret: 'secret' },
      client(calls, readiness()),
    );
    assert.equal(report.cutoverReady, true);
    assert.equal(report.activeVersions.length, 3);
    assert.equal(report.requiredTableCount, 30);
    assert.deepEqual(report.blockers, []);
    assert.ok(calls.some((args) => args.includes('execute')));
    assert.ok(calls.some((args) => args[0] === 'fetch'));
  });

  it('reports durable operational blockers without hiding a healthy deployment', async () => {
    const { stage, plan, rollback, deployResult } = await fixture('blocked');
    const report = await runDeployPostflight(
      stage,
      plan,
      deployResult,
      rollback,
      {},
      client([], readiness({ inbound_unresolved: 2, storage_issues_open: 1 })),
    );
    assert.equal(report.cutoverReady, false);
    assert.deepEqual(report.blockers, [
      { name: 'inboundUnresolved', count: 2 },
      { name: 'storageIssuesOpen', count: 1 },
    ]);
  });

  it('fails closed on missing schema or an unchanged Worker version', async () => {
    const first = await fixture('schema-failure');
    await assert.rejects(
      runDeployPostflight(
        first.stage,
        first.plan,
        first.deployResult,
        first.rollback,
        {},
        client([], readiness({}, TABLES.slice(1))),
      ),
      /missing required table/u,
    );
    const second = await fixture('version-failure');
    const current = second.rollback.workers[0].versionId;
    await assert.rejects(
      runDeployPostflight(
        second.stage,
        second.plan,
        second.deployResult,
        second.rollback,
        {},
        client([], readiness(), current),
      ),
      /pre-deploy Worker version/u,
    );
  });
});

async function fixture(name) {
  const stage = join(root, name);
  const plan = await createDeployStage(stage, MANIFEST, { root: process.cwd(), commit: COMMIT });
  const rollback = await createRollbackPlan(stage, plan, {}, captureClient());
  const deployResult = {
    version: 1,
    kind: 'cf-webmail-deploy-result',
    planId: plan.planId,
    steps: ['migrate', 'deploy:jobs', 'deploy:ingest', 'deploy:web'],
  };
  return { stage, plan, rollback, deployResult };
}

function captureClient() {
  let suffix = 1;
  return {
    spawn: () => ({
      status: 0,
      stdout: JSON.stringify({ versions: [{
        version_id: `${String(suffix++).padStart(8, '0')}-1111-4111-8111-111111111111`,
        percentage: 100,
      }] }),
      stderr: '',
    }),
  };
}

function client(calls, row, version = VERSION) {
  return {
    spawn: (_command, args) => {
      calls.push(args);
      const stdout = args.includes('execute')
        ? JSON.stringify([{ results: [row] }])
        : JSON.stringify({ versions: [{ version_id: version, percentage: 100 }] });
      return { status: 0, stdout, stderr: '' };
    },
    fetch: async (url, options) => {
      calls.push(['fetch', url, options]);
      return new Response(JSON.stringify({
        ok: true, service: 'cf-webmail-web', architectureVersion: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

function readiness(overrides = {}, tables = TABLES) {
  return {
    table_names: tables.join(','),
    inbound_unresolved: 0,
    outbound_unresolved: 0,
    dead_letters_unresolved: 0,
    storage_issues_open: 0,
    retention_unresolved: 0,
    ...overrides,
  };
}
