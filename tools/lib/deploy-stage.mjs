import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { validateDeploymentManifest } from './deploy-manifest.mjs';

const APPS = ['web', 'ingest', 'jobs'];
const STAGE_VERSION = 1;

export async function createDeployStage(stageInput, manifestInput, source) {
  const deployment = validateDeploymentManifest(manifestInput);
  const root = resolve(source.root);
  const commit = String(source.commit ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('source commit must be a full Git SHA');
  const stage = resolve(stageInput);
  await requireEmptyDirectory(stage);
  const configDirectory = join(stage, 'configs');
  await mkdir(configDirectory, { recursive: true });

  const configs = [];
  for (const app of APPS) {
    const sourcePath = join(root, 'apps', app, 'wrangler.jsonc');
    const targetPath = join(configDirectory, `${app}.wrangler.json`);
    const base = JSON.parse(await readFile(sourcePath, 'utf8'));
    const generated = generateConfig(app, base, deployment, dirname(sourcePath), dirname(targetPath));
    const content = JSON.stringify(generated, null, 2) + '\n';
    await writeFile(targetPath, content, { flag: 'wx' });
    configs.push({
      app,
      worker: deployment.workers[app],
      file: `configs/${app}.wrangler.json`,
      sha256: sha256(content),
    });
  }

  const manifestSha256 = sha256(JSON.stringify(deployment));
  const planId = planHash(commit, manifestSha256, configs);
  const plan = {
    version: STAGE_VERSION,
    kind: 'cf-webmail-deploy-stage',
    planId,
    createdAt: Date.now(),
    source: { root, commit },
    deployment,
    manifestSha256,
    configs,
    order: ['migrate', 'deploy-jobs', 'deploy-ingest', 'deploy-web'],
  };
  await writeFile(join(stage, 'manifest.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  return plan;
}

export async function verifyDeployStage(stageInput, expected = {}) {
  const stage = resolve(stageInput);
  const plan = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8'));
  if (plan?.version !== STAGE_VERSION || plan?.kind !== 'cf-webmail-deploy-stage') {
    throw new Error('unsupported deployment stage');
  }
  const deployment = validateDeploymentManifest(plan.deployment);
  if (sha256(JSON.stringify(deployment)) !== plan.manifestSha256) {
    throw new Error('deployment manifest hash mismatch');
  }
  if (!/^[0-9a-f]{40}$/u.test(plan.source?.commit ?? '')) throw new Error('stage source commit is invalid');
  if (expected.root !== undefined && resolve(expected.root) !== plan.source.root) {
    throw new Error('deployment stage belongs to another repository checkout');
  }
  if (expected.commit !== undefined && expected.commit !== plan.source.commit) {
    throw new Error('deployment stage was generated from another commit');
  }
  if (!Array.isArray(plan.configs) || plan.configs.length !== APPS.length) {
    throw new Error('deployment stage config list is invalid');
  }
  const configs = [];
  for (const app of APPS) {
    const descriptor = plan.configs.find((item) => item?.app === app);
    if (descriptor?.file !== `configs/${app}.wrangler.json`) throw new Error(`invalid ${app} config path`);
    const content = await readFile(join(stage, descriptor.file), 'utf8');
    if (sha256(content) !== descriptor.sha256) throw new Error(`${app} config hash mismatch`);
    const config = JSON.parse(content);
    assertGeneratedConfig(app, config, deployment);
    configs.push(descriptor);
  }
  if (planHash(plan.source.commit, plan.manifestSha256, configs) !== plan.planId) {
    throw new Error('deployment plan ID mismatch');
  }
  return plan;
}

function generateConfig(app, base, deployment, sourceDirectory, targetDirectory) {
  const config = structuredClone(base);
  config.account_id = deployment.accountId;
  config.name = deployment.workers[app];
  config.workers_dev = false;
  config.preview_urls = false;
  config.$schema = relativePath(targetDirectory, resolve(sourceDirectory, base.$schema));
  config.main = relativePath(targetDirectory, resolve(sourceDirectory, base.main));
  if (config.assets?.directory) {
    config.assets.directory = relativePath(targetDirectory, resolve(sourceDirectory, config.assets.directory));
  }
  for (const database of config.d1_databases ?? []) {
    if (database.binding !== 'DB') throw new Error(`${app} has an unexpected D1 binding`);
    database.database_name = deployment.resources.d1.name;
    database.database_id = deployment.resources.d1.id;
    database.migrations_dir = relativePath(targetDirectory, resolve(sourceDirectory, database.migrations_dir));
  }
  for (const bucket of config.r2_buckets ?? []) {
    if (bucket.binding !== 'RAW_EMAILS') throw new Error(`${app} has an unexpected R2 binding`);
    bucket.bucket_name = deployment.resources.r2.bucket;
  }
  injectQueues(app, config, deployment);
  if (app === 'web') {
    config.vars = {
      ...config.vars,
      ACCESS_TEAM_DOMAIN: deployment.access.teamDomain,
      ACCESS_AUD: deployment.access.audience,
    };
    config.routes = [{ pattern: deployment.hostname, custom_domain: true }];
  } else {
    delete config.routes;
  }
  assertGeneratedConfig(app, config, deployment);
  return config;
}

function injectQueues(app, config, deployment) {
  const producers = config.queues?.producers ?? [];
  for (const producer of producers) {
    if (producer.binding === 'INBOUND_QUEUE') producer.queue = deployment.resources.queues.inbound;
    else if (producer.binding === 'OUTBOUND_QUEUE') producer.queue = deployment.resources.queues.outbound;
    else throw new Error(`${app} has an unexpected Queue producer`);
  }
  const consumers = config.queues?.consumers ?? [];
  if (app === 'jobs' && consumers.length !== 4) throw new Error('jobs must have four Queue consumers');
  for (const [index, consumer] of consumers.entries()) {
    const definitions = [
      [deployment.resources.queues.inbound, deployment.resources.queues.inboundDlq],
      [deployment.resources.queues.outbound, deployment.resources.queues.outboundDlq],
      [deployment.resources.queues.inboundDlq],
      [deployment.resources.queues.outboundDlq],
    ];
    const definition = definitions[index];
    if (definition === undefined) throw new Error(`${app} has an unexpected Queue consumer`);
    consumer.queue = definition[0];
    if (definition[1] === undefined) delete consumer.dead_letter_queue;
    else consumer.dead_letter_queue = definition[1];
    consumer.max_concurrency = deployment.limits.queueMaxConcurrency;
  }
}

function assertGeneratedConfig(app, config, deployment) {
  if (config.account_id !== deployment.accountId || config.name !== deployment.workers[app]) {
    throw new Error(`${app} config account or Worker name mismatch`);
  }
  if (config.workers_dev !== false || config.preview_urls !== false) {
    throw new Error(`${app} config must disable workers.dev and preview URLs`);
  }
  const database = config.d1_databases?.find((item) => item.binding === 'DB');
  if (database?.database_id !== deployment.resources.d1.id) throw new Error(`${app} D1 binding mismatch`);
  const bucket = config.r2_buckets?.find((item) => item.binding === 'RAW_EMAILS');
  if (bucket?.bucket_name !== deployment.resources.r2.bucket) throw new Error(`${app} R2 binding mismatch`);
  const expectedProducers = app === 'ingest'
    ? [['INBOUND_QUEUE', deployment.resources.queues.inbound]]
    : app === 'jobs'
      ? [
        ['INBOUND_QUEUE', deployment.resources.queues.inbound],
        ['OUTBOUND_QUEUE', deployment.resources.queues.outbound],
      ]
      : [['OUTBOUND_QUEUE', deployment.resources.queues.outbound]];
  for (const expectedProducer of expectedProducers) {
    const producer = config.queues?.producers?.find((item) => item.binding === expectedProducer[0]);
    if (producer?.queue !== expectedProducer[1]) throw new Error(`${app} Queue producer mismatch`);
  }
  if (app === 'web') {
    if (config.routes?.[0]?.pattern !== deployment.hostname || config.routes[0].custom_domain !== true) {
      throw new Error('web custom domain mismatch');
    }
    if (config.vars?.ACCESS_TEAM_DOMAIN !== deployment.access.teamDomain || config.vars?.ACCESS_AUD !== deployment.access.audience) {
      throw new Error('web Access configuration mismatch');
    }
  }
  if (app === 'jobs') {
    if (JSON.stringify(config.secrets?.required) !== JSON.stringify(['SMTP2GO_API_KEY'])) {
      throw new Error('jobs must require the SMTP2GO_API_KEY secret');
    }
    const expectedConsumers = [
      [deployment.resources.queues.inbound, deployment.resources.queues.inboundDlq],
      [deployment.resources.queues.outbound, deployment.resources.queues.outboundDlq],
      [deployment.resources.queues.inboundDlq, undefined],
      [deployment.resources.queues.outboundDlq, undefined],
    ];
    if (config.queues?.consumers?.length !== expectedConsumers.length) {
      throw new Error('jobs Queue consumer count mismatch');
    }
    for (const [index, expected] of expectedConsumers.entries()) {
      const consumer = config.queues.consumers[index];
      if (
        consumer.queue !== expected[0]
        || consumer.dead_letter_queue !== expected[1]
        || consumer.max_concurrency !== deployment.limits.queueMaxConcurrency
      ) throw new Error('jobs Queue consumer mismatch');
    }
  }
}

function planHash(commit, manifestSha256, configs) {
  return sha256(JSON.stringify({
    commit,
    manifestSha256,
    configs: configs.map(({ app, worker, file, sha256: hash }) => ({ app, worker, file, sha256: hash })),
  }));
}

function relativePath(from, to) {
  const value = relative(from, to).replaceAll('\\', '/');
  return value.startsWith('.') ? value : `./${value}`;
}

async function requireEmptyDirectory(path) {
  await mkdir(path, { recursive: true });
  if ((await readdir(path)).length !== 0) throw new Error(`deployment stage is not empty: ${path}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
