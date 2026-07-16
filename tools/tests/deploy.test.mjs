import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertBackupTarget } from '../lib/deploy-cli.mjs';
import { runDeployApply, runDeployPreflight } from '../lib/deploy-cloudflare.mjs';
import {
  createRollbackPlan,
  extractActiveVersion,
  runRollbackApply,
  validateRollbackPlan,
} from '../lib/deploy-rollback.mjs';
import { validateDeploymentManifest } from '../lib/deploy-manifest.mjs';
import { createDeployStage, verifyDeployStage } from '../lib/deploy-stage.mjs';

const COMMIT = 'c'.repeat(40);
const D1_ID = '11111111-1111-4111-8111-111111111111';
const MANIFEST = {
  version: 1,
  environment: 'production',
  mode: 'initial',
  accountId: 'a'.repeat(32),
  hostname: 'mail.example.com',
  workers: {
    web: 'cf-webmail-web',
    ingest: 'cf-webmail-ingest',
    jobs: 'cf-webmail-jobs',
  },
  access: {
    teamDomain: 'https://example-team.cloudflareaccess.com',
    audience: 'b'.repeat(64),
  },
  resources: {
    d1: { name: 'cf-webmail', id: D1_ID },
    r2: { bucket: 'cf-webmail-raw' },
    queues: {
      inbound: 'cf-webmail-inbound',
      inboundDlq: 'cf-webmail-inbound-dlq',
      outbound: 'cf-webmail-outbound',
      outboundDlq: 'cf-webmail-outbound-dlq',
    },
  },
  email: {
    sendingDomains: ['example.com'],
    routingDomains: ['example.com'],
  },
  limits: { queueMaxConcurrency: 1 },
};

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cf-webmail-deploy-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('review-first deployment stage', () => {
  it('generates production-only configs bound to one manifest and commit', async () => {
    const { stage, plan } = await stageFixture('generated');
    const verified = await verifyDeployStage(stage, { root: process.cwd(), commit: COMMIT });
    assert.equal(verified.planId, plan.planId);

    const web = JSON.parse(await readFile(join(stage, 'configs/web.wrangler.json'), 'utf8'));
    const jobs = JSON.parse(await readFile(join(stage, 'configs/jobs.wrangler.json'), 'utf8'));
    assert.deepEqual(web.routes, [{ pattern: 'mail.example.com', custom_domain: true }]);
    assert.equal(web.d1_databases[0].database_id, D1_ID);
    assert.equal(web.vars.ACCESS_AUD, 'b'.repeat(64));
    assert.equal(jobs.queues.consumers[0].max_concurrency, 1);
    assert.equal(jobs.queues.consumers[1].dead_letter_queue, 'cf-webmail-outbound-dlq');
    assert.equal(jobs.queues.consumers[2].queue, 'cf-webmail-inbound-dlq');
    assert.equal(jobs.queues.consumers[2].dead_letter_queue, undefined);
    assert.equal(jobs.queues.consumers[3].queue, 'cf-webmail-outbound-dlq');
    assert.equal(jobs.queues.producers[0].queue, 'cf-webmail-inbound');
  });

  it('runs read-only checks before migrations and deploys in dependency order', async () => {
    const { stage, plan } = await stageFixture('preflight');
    const calls = [];
    const report = await runDeployPreflight(stage, plan, {}, fakeRunner(calls, 0));
    assert.equal(report.databaseEmpty, true);
    assert.ok(report.checks.includes('email-sending:example.com'));
    assert.ok(calls.some((args) => args.includes('--dry-run')));

    const mutationCalls = [];
    const result = runDeployApply(stage, plan, report, {}, fakeRunner(mutationCalls, 0));
    assert.deepEqual(result.steps, ['migrate', 'deploy:jobs', 'deploy:ingest', 'deploy:web']);
    assert.ok(mutationCalls[0].includes('migrations'));
    assert.match(mutationCalls[1].join(' '), /jobs\.wrangler\.json/u);
    assert.match(mutationCalls[2].join(' '), /ingest\.wrangler\.json/u);
    assert.match(mutationCalls[3].join(' '), /web\.wrangler\.json/u);
  });

  it('rejects nonempty initial targets, altered stages, and wrong backups', async () => {
    const { stage, plan } = await stageFixture('guards');
    const report = await runDeployPreflight(stage, plan, {}, fakeRunner([], 2));
    assert.equal(report.databaseEmpty, false);
    assert.throws(() => runDeployApply(stage, plan, report, {}, fakeRunner([], 0)), /empty D1/u);

    assert.throws(
      () => assertBackupTarget(stage, plan, {
        source: {
          mode: 'remote',
          database: 'another-db',
          bucket: 'cf-webmail-raw',
          config: join(stage, 'configs/web.wrangler.json'),
        },
      }),
      /does not match/u,
    );
    assert.doesNotThrow(() => assertBackupTarget(stage, plan, {
      source: {
        mode: 'remote',
        database: 'cf-webmail',
        bucket: 'cf-webmail-raw',
        config: join(stage, 'configs/web.wrangler.json'),
      },
    }));
    const config = join(stage, 'configs/web.wrangler.json');
    await writeFile(config, `${await readFile(config, 'utf8')}\n`);
    await assert.rejects(verifyDeployStage(stage), /hash mismatch/u);
  });

  it('fails closed on placeholder-like or misspelled manifest fields', () => {
    assert.throws(
      () => validateDeploymentManifest({ ...MANIFEST, accountId: 'REPLACE_WITH_ACCOUNT' }),
      /accountId/u,
    );
    assert.throws(
      () => validateDeploymentManifest({ ...MANIFEST, hostName: MANIFEST.hostname }),
      /unknown field/u,
    );
  });

  it('captures exact pre-deploy versions and rolls back in exposure order', async () => {
    const { stage, plan } = await stageFixture('rollback', { ...MANIFEST, mode: 'upgrade' });
    const captureCalls = [];
    const rollback = await createRollbackPlan(stage, plan, {}, versionRunner(captureCalls));
    assert.equal(rollback.available, true);
    assert.equal(rollback.workers.length, 3);
    assert.doesNotThrow(() => validateRollbackPlan(plan, rollback));
    assert.equal(captureCalls.length, 3);
    assert.ok(captureCalls.every((args) => args.includes('status') && args.includes('--json')));

    const applyCalls = [];
    const result = runRollbackApply(
      stage,
      plan,
      rollback,
      { reason: 'failed production smoke checks' },
      versionRunner(applyCalls),
    );
    assert.deepEqual(result.steps, ['rollback:web', 'rollback:ingest', 'rollback:jobs']);
    assert.equal(result.databaseRolledBack, false);
    assert.match(applyCalls[0].join(' '), /web\.wrangler\.json/u);
    assert.match(applyCalls[1].join(' '), /ingest\.wrangler\.json/u);
    assert.match(applyCalls[2].join(' '), /jobs\.wrangler\.json/u);
  });

  it('rejects split traffic and records that initial deploys have no code rollback', async () => {
    assert.throws(
      () => extractActiveVersion(JSON.stringify({ versions: [
        { version_id: '11111111-1111-4111-8111-111111111111', percentage: 50 },
        { version_id: '22222222-2222-4222-8222-222222222222', percentage: 50 },
      ] })),
      /exactly one active version|split-traffic/u,
    );
    const { stage, plan } = await stageFixture('initial-rollback');
    const calls = [];
    const rollback = await createRollbackPlan(stage, plan, {}, versionRunner(calls));
    assert.equal(rollback.available, false);
    assert.deepEqual(rollback.workers, []);
    assert.deepEqual(calls, []);
  });
});

async function stageFixture(name, manifest = MANIFEST) {
  const stage = join(root, name);
  const plan = await createDeployStage(stage, manifest, { root: process.cwd(), commit: COMMIT });
  return { stage, plan };
}

function versionRunner(calls) {
  let version = 1;
  return {
    spawn: (_command, args) => {
      calls.push(args);
      if (args.includes('status')) {
        const id = `${String(version).padStart(8, '0')}-1111-4111-8111-111111111111`;
        version += 1;
        return {
          status: 0,
          stdout: JSON.stringify({ versions: [{ version_id: id, percentage: 100 }] }),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

function fakeRunner(calls, tableCount) {
  return {
    spawn: (_command, args) => {
      calls.push(args);
      if (args.includes('info') && args.includes('d1')) {
        return { status: 0, stdout: JSON.stringify({ uuid: D1_ID, name: 'cf-webmail' }), stderr: '' };
      }
      if (args.includes('bucket') && args.includes('info')) {
        return { status: 0, stdout: JSON.stringify({ name: 'cf-webmail-raw' }), stderr: '' };
      }
      if (args.includes('queues') && args.includes('info')) {
        return { status: 0, stdout: String(args[args.indexOf('info') + 1]), stderr: '' };
      }
      if (args.includes('execute')) {
        return { status: 0, stdout: JSON.stringify([{ results: [{ table_count: tableCount }] }]), stderr: '' };
      }
      if (args.includes('sending')) {
        return { status: 0, stdout: 'name enabled tag\ncf-bounce.example.com yes fixture', stderr: '' };
      }
      if (args.includes('routing') && args.includes('settings')) {
        return { status: 0, stdout: 'Email Routing for example.com:\n  Enabled:  true\n', stderr: '' };
      }
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  };
}
