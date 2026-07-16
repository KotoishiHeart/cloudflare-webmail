import { writeFile } from 'node:fs/promises';
import { parseOptions } from './ops-cli.mjs';
import { createLegacyInventory, createLegacyMappingTemplate, loadAndValidateLegacyMapping } from './legacy-inventory.mjs';
import { importLegacySafeSql } from './legacy-sqlite.mjs';
import { fetchLegacySnapshot, verifyLegacySnapshot } from './legacy-snapshot.mjs';
import { prepareLegacyMigrationStage } from './legacy-stage.mjs';
import { verifyMigrationStage } from './migration-stage.mjs';

export async function runLegacyMigrationCli(argv, io = {
  stdout: (value) => process.stdout.write(value),
}) {
  const [command = 'help', ...args] = argv;
  const options = parseOptions(args);
  if (command === 'help' || options.help) {
    io.stdout(usage());
    return 0;
  }
  if (command === 'import-sql') {
    const result = await importLegacySafeSql({
      sql: required(options, 'sql'),
      database: required(options, 'database'),
    });
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === 'inventory') {
    const inventory = createLegacyInventory(required(options, 'database'));
    await writeExclusive(required(options, 'output'), inventory);
    if (typeof options['mapping-template'] === 'string') {
      await writeExclusive(options['mapping-template'], createLegacyMappingTemplate(inventory));
    }
    io.stdout(`${JSON.stringify(inventory, null, 2)}\n`);
    return Object.values(inventory.integrity).every((count) => count === 0) ? 0 : 2;
  }
  if (command === 'validate-mapping') {
    const inventory = createLegacyInventory(required(options, 'database'));
    const mapping = await loadAndValidateLegacyMapping(required(options, 'mapping'), inventory);
    io.stdout(`${JSON.stringify({
      ok: true,
      mappedAccounts: mapping.mappings.length,
      excludedAccounts: mapping.exclusions.length,
    }, null, 2)}\n`);
    return 0;
  }
  if (command === 'fetch') {
    const database = required(options, 'database');
    const mapping = await loadAndValidateLegacyMapping(
      required(options, 'mapping'),
      createLegacyInventory(database),
    );
    const result = await fetchLegacySnapshot({
      database,
      mapping,
      snapshot: required(options, 'snapshot'),
      objectRoot: options['object-root'],
      bucket: options.bucket,
      local: Boolean(options.local),
      remote: Boolean(options.remote),
      config: options.config,
      persistTo: options['persist-to'],
      concurrency: options.concurrency,
      io,
    });
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result.complete ? 0 : 2;
  }
  if (command === 'verify-snapshot') {
    const database = required(options, 'database');
    const mapping = await loadAndValidateLegacyMapping(
      required(options, 'mapping'),
      createLegacyInventory(database),
    );
    const result = await verifyLegacySnapshot({
      database,
      mapping,
      snapshot: required(options, 'snapshot'),
    });
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === 'prepare') {
    const database = required(options, 'database');
    const inventory = createLegacyInventory(database);
    const integrityFailures = Object.entries(inventory.integrity).filter(([, count]) => count !== 0);
    if (integrityFailures.length > 0) {
      throw new Error(`legacy inventory has ${integrityFailures.length} nonzero integrity check(s)`);
    }
    const mapping = await loadAndValidateLegacyMapping(required(options, 'mapping'), inventory);
    const result = await prepareLegacyMigrationStage({
      database,
      mapping,
      snapshot: required(options, 'snapshot'),
      stage: required(options, 'stage'),
    });
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result.complete ? 0 : 2;
  }
  if (command === 'verify-stage') {
    const result = await verifyMigrationStage(required(options, 'stage'));
    io.stdout(`${JSON.stringify(result.manifest, null, 2)}\n`);
    return result.manifest.complete === false ? 2 : 0;
  }
  throw new Error(`unknown command: ${command}`);
}

async function writeExclusive(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value === '') throw new Error(`--${key} is required`);
  return value;
}

function usage() {
  return `Cloudflare Webmail archived migration\n\n` +
    `  import-sql --sql OLD_SAFE_BACKUP.sql --database legacy.sqlite\n` +
    `  inventory --database legacy.sqlite --output inventory.json \\\n` +
    `    [--mapping-template mapping.json]\n` +
    `  validate-mapping --database legacy.sqlite --mapping mapping.json\n` +
    `  fetch --database legacy.sqlite --mapping mapping.json --snapshot DIR \\\n` +
    `    (--object-root DIR | --bucket NAME (--local|--remote) --config FILE)\n` +
    `  verify-snapshot --database legacy.sqlite --mapping mapping.json --snapshot DIR\n` +
    `  prepare --database legacy.sqlite --mapping mapping.json --snapshot DIR --stage DIR\n` +
    `  verify-stage --stage DIR\n`;
}
