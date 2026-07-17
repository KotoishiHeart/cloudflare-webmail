import { writeFile } from 'node:fs/promises';
import {
  createLegacyInventory,
  loadAndValidateLegacyMapping,
  validateLegacyMapping,
} from './legacy-inventory.mjs';

export async function refreshLegacyMapping(options) {
  const baseline = await loadAndValidateLegacyMapping(
    options.mapping,
    createLegacyInventory(options.baselineDatabase),
  );
  const inventory = createLegacyInventory(options.database);
  const refreshed = validateLegacyMapping({
    ...baseline,
    sourceDatabaseSha256: inventory.source.databaseSha256,
  }, inventory);
  await writeFile(
    options.output,
    `${JSON.stringify(refreshed, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return {
    ok: true,
    mappedAccounts: refreshed.mappings.length,
    excludedAccounts: refreshed.exclusions.length,
  };
}

export async function refreshLegacyMappingFromCli(options) {
  return refreshLegacyMapping({
    baselineDatabase: required(options, 'baseline-database'),
    database: required(options, 'database'),
    mapping: required(options, 'mapping'),
    output: required(options, 'output'),
  });
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value === '') throw new Error(`--${key} is required`);
  return value;
}
