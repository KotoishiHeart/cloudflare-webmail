import { createLegacyInventory, loadAndValidateLegacyMapping } from './legacy-inventory.mjs';
import { prepareLegacyDeltaStage } from './legacy-delta-stage.mjs';

export async function prepareLegacyDeltaFromCli(options) {
  const database = required(options, 'database');
  const inventory = createLegacyInventory(database);
  const failures = Object.entries(inventory.integrity).filter(([, count]) => count !== 0);
  if (failures.length > 0) {
    throw new Error(`final legacy inventory has ${failures.length} nonzero integrity check(s)`);
  }
  const mapping = await loadAndValidateLegacyMapping(required(options, 'mapping'), inventory);
  return prepareLegacyDeltaStage({
    baselineDatabase: required(options, 'baseline-database'),
    baselineStage: required(options, 'baseline-stage'),
    database,
    mapping,
    snapshot: required(options, 'snapshot'),
    stage: required(options, 'stage'),
  });
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value === '') throw new Error(`--${key} is required`);
  return value;
}
