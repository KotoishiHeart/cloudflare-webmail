import { spawnSync } from 'node:child_process';
import { parseOptions } from './ops-cli.mjs';
import { createBackup, restoreBackup, verifyBackup } from './backup-core.mjs';

export async function runBackupCli(argv, io = defaultIo()) {
  const [command = 'help', ...args] = argv;
  const options = parseOptions(args);
  if (command === 'help' || options.help) {
    io.stdout(usage());
    return 0;
  }
  if (command === 'create') {
    const manifest = await createBackup(required(options, 'output'), targetOptions(options), io);
    io.stdout(`${JSON.stringify(summary(manifest), null, 2)}\n`);
    return 0;
  }
  if (command === 'verify') {
    const manifest = await verifyBackup(required(options, 'backup'));
    io.stdout(`${JSON.stringify(summary(manifest), null, 2)}\n`);
    return 0;
  }
  if (command === 'restore') {
    if (!options.yes) throw new Error('restore changes R2 and D1; pass --yes after verification');
    const state = await restoreBackup(required(options, 'backup'), {
      ...targetOptions(options),
      emptyTarget: Boolean(options['empty-target']),
    }, io);
    io.stdout(`${JSON.stringify(state, null, 2)}\n`);
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}

function targetOptions(options) {
  if (Boolean(options.local) === Boolean(options.remote)) {
    throw new Error('specify exactly one of --local or --remote');
  }
  return {
    local: Boolean(options.local),
    remote: Boolean(options.remote),
    database: options.database ?? 'cf-webmail',
    bucket: options.bucket ?? 'cf-webmail-raw',
    config: options.config ?? 'apps/web/wrangler.jsonc',
    persistTo: options['persist-to'],
  };
}

function summary(manifest) {
  return {
    version: manifest.version,
    kind: manifest.kind,
    createdAt: manifest.createdAt,
    d1Bytes: manifest.d1.size,
    objects: manifest.objects.length,
  };
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value === '') throw new Error(`--${key} is required`);
  return value;
}

function defaultIo() {
  return { stdout: (value) => process.stdout.write(value), spawn: spawnSync };
}

function usage() {
  return `Cloudflare Webmail backup\n\n` +
    `  create --output DIR (--local|--remote)\n` +
    `  verify --backup DIR\n` +
    `  restore --backup DIR (--local|--remote) --empty-target --yes\n\n` +
    `Options: --database NAME --bucket NAME --config FILE --persist-to DIR\n`;
}
