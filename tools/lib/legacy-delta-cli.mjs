import { access, writeFile } from 'node:fs/promises';
import { createLegacyInventory, loadAndValidateLegacyMapping } from './legacy-inventory.mjs';
import { prepareLegacyDeltaStage } from './legacy-delta-stage.mjs';
import { rehearseLegacyDeltaCapacity } from './legacy-delta-capacity.mjs';
import { legacyStageCliSummary } from './legacy-cli-view.mjs';

export async function runLegacyDeltaCli(command, options, io) {
  if (command === 'prepare-delta') {
    const result = await prepareLegacyDeltaFromCli(options);
    io.stdout(`${JSON.stringify(legacyStageCliSummary(result), null, 2)}\n`);
    return result.complete ? 0 : 2;
  }
  const output = required(options, 'output');
  await requireMissing(output);
  const result = await rehearseLegacyDeltaCapacity({
    baselineDatabase: required(options, 'baseline-database'),
    baselineStage: required(options, 'baseline-stage'),
    stage: required(options, 'stage'),
    database: required(options, 'database'),
  });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.freePlan.d1DatabaseFits
    && result.freePlan.r2StorageFits && result.freePlan.r2DeltaWritesFit ? 0 : 2;
}

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

async function requireMissing(path) {
  try {
    await access(path);
    throw new Error(`output already exists: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
