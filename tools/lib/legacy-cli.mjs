import { readFile, writeFile } from 'node:fs/promises';
import { parseOptions } from './ops-cli.mjs';
import {
  createLegacyInventory,
  createLegacyMappingTemplate,
  legacyMappingSha256,
  loadAndValidateLegacyMapping,
} from './legacy-inventory.mjs';
import { importLegacySafeSql } from './legacy-sqlite.mjs';
import { fetchLegacySnapshot, verifyLegacySnapshot } from './legacy-snapshot.mjs';
import { fetchLegacySnapshotBulk } from './legacy-snapshot-bulk.mjs';
import { prepareLegacyMigrationStage } from './legacy-stage.mjs';
import { verifyMigrationStage } from './migration-stage.mjs';
import { applyLegacyStageBulk } from './legacy-bulk-apply.mjs';
import { auditLegacyStageBulk } from './legacy-bulk-audit.mjs';
import { createLegacyProvisioningDraft } from './legacy-provisioning.mjs';
import { verifyLegacyProvisioningFiles } from './legacy-provisioning-verify.mjs';
import { rehearseLegacyCapacity } from './legacy-capacity.mjs';
import { legacyMigrationUsage, legacyStageCliSummary } from './legacy-cli-view.mjs';

export async function runLegacyMigrationCli(argv, io = {
  stdout: (value) => process.stdout.write(value),
}) {
  const [command = 'help', ...args] = argv;
  const options = parseOptions(args);
  if (command === 'help' || options.help) {
    io.stdout(legacyMigrationUsage());
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
    const integrityOk = Object.values(inventory.integrity).every((count) => count === 0);
    io.stdout(`${JSON.stringify({
      ok: integrityOk,
      accounts: inventory.accounts.length,
      accountsWithMessages: inventory.accounts.filter(
        (account) => account.counts.messages > 0,
      ).length,
      counts: inventory.counts,
      integrity: inventory.integrity,
    }, null, 2)}\n`);
    return integrityOk ? 0 : 2;
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
  if (command === 'provision-template') {
    const database = required(options, 'database');
    const inventory = createLegacyInventory(database);
    const mapping = await loadAndValidateLegacyMapping(required(options, 'mapping'), inventory);
    const output = required(options, 'output');
    const report = required(options, 'report');
    await Promise.all([requireMissing(output), requireMissing(report)]);
    const result = createLegacyProvisioningDraft({
      database,
      mapping,
      mappingSha256: legacyMappingSha256(mapping),
      owner: {
        userId: required(options, 'owner-user-id'),
        email: required(options, 'owner-email'),
        displayName: typeof options['owner-display-name'] === 'string'
          ? options['owner-display-name'] : undefined,
        issuer: required(options, 'access-issuer'),
        subject: required(options, 'access-subject'),
        systemAdmin: Boolean(options['system-admin']),
      },
    });
    await writeExclusive(output, result.manifest);
    await writeExclusive(report, result.review);
    io.stdout(`${JSON.stringify({
      ok: true,
      mailboxes: result.manifest.mailboxes.length,
      aliases: result.review.generated.aliases,
      externalAliases: result.review.externalAliases.length,
      membershipSuggestions: result.review.membershipSuggestions.length,
    }, null, 2)}\n`);
    return 0;
  }
  if (command === 'verify-provisioning') {
    const output = required(options, 'output');
    await requireMissing(output);
    const result = await verifyLegacyProvisioningFiles({
      database: required(options, 'database'),
      mapping: required(options, 'mapping'),
      manifest: required(options, 'manifest'),
      review: required(options, 'review'),
      deployment: required(options, 'deployment'),
    });
    await writeExclusive(output, result);
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === 'fetch' || command === 'bulk-fetch') {
    const database = required(options, 'database');
    const mapping = await loadAndValidateLegacyMapping(
      required(options, 'mapping'),
      createLegacyInventory(database),
    );
    const common = { database, mapping, snapshot: required(options, 'snapshot'), io };
    const result = command === 'bulk-fetch'
      ? await fetchLegacySnapshotBulk({
        ...common, rcloneSource: required(options, 'rclone-source'),
        rcloneConfig: options['rclone-config'], transfers: options.transfers,
        checkers: options.checkers, concurrency: options.concurrency,
      })
      : await fetchLegacySnapshot({
        ...common, objectRoot: options['object-root'], bucket: options.bucket,
        local: Boolean(options.local), remote: Boolean(options.remote),
        config: options.config, persistTo: options['persist-to'],
        concurrency: options.concurrency,
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
    io.stdout(`${JSON.stringify(legacyStageCliSummary(result), null, 2)}\n`);
    return result.complete ? 0 : 2;
  }
  if (command === 'verify-stage') {
    const result = await verifyMigrationStage(required(options, 'stage'));
    io.stdout(`${JSON.stringify(legacyStageCliSummary(result.manifest), null, 2)}\n`);
    return result.manifest.complete === false ? 2 : 0;
  }
  if (command === 'capacity-rehearsal') {
    const output = required(options, 'output');
    await requireMissing(output);
    const result = await rehearseLegacyCapacity(
      required(options, 'stage'),
      required(options, 'database'),
      typeof options.provisioning === 'string' ? { provisioning: options.provisioning } : {},
    );
    await writeExclusive(output, result);
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result.freePlan.d1DatabaseFits
      && result.freePlan.r2StorageFits
      && result.freePlan.r2InitialWritesFit ? 0 : 2;
  }
  if (command === 'bulk-apply') {
    const result = await applyLegacyStageBulk(required(options, 'stage'), {
      yes: Boolean(options.yes),
      local: Boolean(options.local),
      remote: Boolean(options.remote),
      database: options.database ?? 'cf-webmail',
      config: options.config ?? 'apps/web/wrangler.jsonc',
      persistTo: options['persist-to'],
      tree: options.tree,
      rcloneDestination: required(options, 'rclone-destination'),
      rcloneConfig: options['rclone-config'],
      transfers: options.transfers,
      checkers: options.checkers,
    });
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === 'bulk-audit') {
    const output = required(options, 'output');
    await requireMissing(output);
    const result = await auditLegacyStageBulk(required(options, 'stage'), {
      local: Boolean(options.local),
      remote: Boolean(options.remote),
      database: options.database ?? 'cf-webmail',
      config: options.config ?? 'apps/web/wrangler.jsonc',
      persistTo: options['persist-to'],
      tree: required(options, 'tree'),
      report: required(options, 'report'),
      rcloneDestination: required(options, 'rclone-destination'),
      rcloneConfig: options['rclone-config'],
      checkers: options.checkers,
    });
    await writeExclusive(output, result);
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}

async function writeExclusive(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

async function requireMissing(path) {
  await readFile(path).then(
    () => { throw new Error(`output already exists: ${path}`); },
    (error) => { if (error?.code !== 'ENOENT') throw error; },
  );
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value === '') throw new Error(`--${key} is required`);
  return value;
}
