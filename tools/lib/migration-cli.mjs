import { parseOptions } from './ops-cli.mjs';
import { spawnSync } from 'node:child_process';
import {
  applyMigrationStage,
  prepareMigrationStage,
  verifyMigrationStage,
} from './migration-stage.mjs';

export async function runMigrationCli(argv, io = {
  stdout: (value) => process.stdout.write(value),
  spawn: spawnSync,
}) {
  const [command = 'help', ...args] = argv;
  const options = parseOptions(args);
  if (command === 'help' || options.help) {
    io.stdout(usage());
    return 0;
  }
  if (command === 'prepare') {
    const direction = options.direction ?? 'inbound';
    if (direction !== 'inbound' && direction !== 'outbound') {
      throw new Error('--direction must be inbound or outbound');
    }
    const manifest = await prepareMigrationStage({
      source: required(options, 'source'),
      format: required(options, 'format'),
      stage: required(options, 'stage'),
      mailboxId: uuid(required(options, 'mailbox-id'), '--mailbox-id'),
      address: email(required(options, 'address'), '--address'),
      direction,
    });
    io.stdout(`${JSON.stringify(manifest, null, 2)}\n`);
    return manifest.counts.failed === 0 ? 0 : 2;
  }
  if (command === 'verify') {
    const result = await verifyMigrationStage(required(options, 'stage'));
    io.stdout(`${JSON.stringify(result.manifest, null, 2)}\n`);
    return 0;
  }
  if (command === 'apply') {
    if (!options.yes) throw new Error('apply changes R2 and D1; pass --yes after verification');
    if (Boolean(options.local) === Boolean(options.remote)) {
      throw new Error('specify exactly one of --local or --remote');
    }
    const state = await applyMigrationStage(required(options, 'stage'), {
      local: Boolean(options.local),
      remote: Boolean(options.remote),
      bucket: options.bucket ?? 'cf-webmail-raw',
      database: options.database ?? 'cf-webmail',
      config: options.config ?? 'apps/web/wrangler.jsonc',
      persistTo: options['persist-to'],
    }, io);
    io.stdout(`${JSON.stringify(state, null, 2)}\n`);
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value === '') throw new Error(`--${key} is required`);
  return value;
}

function uuid(value, path) {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new Error(`${path} must be a UUID`);
  }
  return normalized;
}

function email(value, path) {
  const normalized = value.trim().toLowerCase();
  const at = normalized.indexOf('@');
  if (
    !/^[^\s@]+@[^\s@]+$/u.test(normalized)
    || normalized.length > 320
    || at > 64
    || normalized.length - at - 1 > 255
  ) {
    throw new Error(`${path} must be an email address`);
  }
  return normalized;
}

function usage() {
  return `Cloudflare Webmail migration\n\n` +
    `  prepare --source DIR --format maildir|eml-tree --stage DIR \\\n` +
    `    --mailbox-id UUID --address EMAIL [--direction inbound|outbound]\n` +
    `  verify --stage DIR\n` +
    `  apply --stage DIR (--local|--remote) --yes\n\n` +
    `Apply options: --bucket NAME --database NAME --config FILE --persist-to DIR\n`;
}
