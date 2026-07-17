import { access, chmod, copyFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifyMigrationStage } from './migration-stage.mjs';
import { stageSha256 } from './legacy-bulk-stage.mjs';

const D1_FREE_DATABASE_BYTES = 500_000_000;
const D1_FREE_DAILY_ROWS_WRITTEN = 100_000;
const R2_FREE_STORAGE_BYTES = 10_000_000_000;
const R2_FREE_MONTHLY_CLASS_A = 1_000_000;

export async function rehearseLegacyDeltaCapacity(options) {
  const databasePath = resolve(options.database);
  await assertMissing(databasePath);
  const [baselineStage, deltaStage] = await Promise.all([
    verifyMigrationStage(options.baselineStage),
    verifyMigrationStage(options.stage),
  ]);
  requireStages(baselineStage, deltaStage);
  const baselineDatabasePath = resolve(options.baselineDatabase);
  await requireCheckpointedDatabase(baselineDatabasePath);
  await copyFile(baselineDatabasePath, databasePath);
  await chmod(databasePath, 0o600);
  let database;
  try {
    database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = MEMORY;');
    await ensureDeltaSchema(database, options.migrations ?? 'migrations');
    const baseline = databaseMetrics(database);
    requireBaselineBatch(database, deltaStage.manifest);
    for (const descriptor of deltaStage.manifest.sqlFiles) {
      try {
        database.exec(await readFile(resolve(options.stage, descriptor.file), 'utf8'));
      } catch (error) {
        throw new Error(
          `delta capacity rehearsal failed at ${descriptor.file}: ${message(error)}`,
          { cause: error },
        );
      }
    }
    database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const final = databaseMetrics(database);
    const baselineR2Bytes = sumObjectBytes(baselineStage.objects);
    const deltaR2Bytes = sumObjectBytes(deltaStage.objects);
    const declaredWrites = 1 + deltaStage.manifest.counts.changes
      + deltaStage.manifest.counts.newMessages;
    database.close();
    return {
      version: 1,
      kind: 'cf-webmail-legacy-delta-capacity-rehearsal',
      createdAt: options.now ?? Date.now(),
      baselineBatchId: deltaStage.manifest.baselineBatchId,
      deltaId: deltaStage.manifest.deltaId,
      baselineStageSha256: stageSha256(baselineStage.manifest, baselineStage.objects),
      deltaStageSha256: stageSha256(deltaStage.manifest, deltaStage.objects),
      counts: {
        ...deltaStage.manifest.counts,
        baselineTableRows: baseline.tableRows,
        finalTableRows: final.tableRows,
        baseRowDelta: final.baseRows - baseline.baseRows,
        declaredWrites,
        baselineR2Objects: baselineStage.objects.length,
        deltaR2Objects: deltaStage.objects.length,
        finalR2Objects: baselineStage.objects.length + deltaStage.objects.length,
        baselineR2Bytes,
        deltaR2Bytes,
        finalR2Bytes: baselineR2Bytes + deltaR2Bytes,
      },
      sqlite: {
        baselineDatabaseBytes: baseline.databaseBytes,
        finalDatabaseBytes: final.databaseBytes,
        databaseGrowthBytes: final.databaseBytes - baseline.databaseBytes,
        pageSize: final.pageSize,
        pageCount: final.pageCount,
        freePages: final.freePages,
      },
      freePlan: {
        limitsAsOf: '2026-04-21',
        d1DatabaseBytes: D1_FREE_DATABASE_BYTES,
        d1DailyRowsWritten: D1_FREE_DAILY_ROWS_WRITTEN,
        r2StorageBytes: R2_FREE_STORAGE_BYTES,
        r2MonthlyClassAOperations: R2_FREE_MONTHLY_CLASS_A,
        d1DatabaseFits: final.databaseBytes <= D1_FREE_DATABASE_BYTES,
        minimumDeclaredWriteDays: Math.ceil(declaredWrites / D1_FREE_DAILY_ROWS_WRITTEN),
        r2StorageFits: baselineR2Bytes + deltaR2Bytes <= R2_FREE_STORAGE_BYTES,
        r2DeltaWritesFit: deltaStage.objects.length <= R2_FREE_MONTHLY_CLASS_A,
      },
    };
  } catch (error) {
    try { database?.close(); } catch {}
    await Promise.all([
      rm(databasePath, { force: true }),
      rm(`${databasePath}-shm`, { force: true }),
      rm(`${databasePath}-wal`, { force: true }),
    ]);
    throw error;
  }
}

function requireStages(baseline, delta) {
  if (baseline.manifest.version !== 3 || baseline.manifest.complete !== true) {
    throw new Error('delta capacity rehearsal requires a complete baseline stage');
  }
  if (delta.manifest.version !== 4 || delta.manifest.complete !== true) {
    throw new Error('delta capacity rehearsal requires a complete delta stage');
  }
  if (
    delta.manifest.baselineBatchId !== baseline.manifest.batchId
    || delta.manifest.baselineStageSha256 !== stageSha256(baseline.manifest, baseline.objects)
  ) throw new Error('delta stage does not belong to the supplied baseline stage');
}

async function ensureDeltaSchema(database, migrationsInput) {
  const exists = database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'legacy_migration_deltas'
  `).get();
  if (exists !== undefined) return;
  const migrations = resolve(migrationsInput);
  const name = (await readdir(migrations)).find((item) => /^0017_.*\.sql$/u.test(item));
  if (name === undefined) throw new Error('legacy delta audit migration was not found');
  database.exec(await readFile(resolve(migrations, name), 'utf8'));
}

function requireBaselineBatch(database, manifest) {
  const row = database.prepare(`
    SELECT source_database_sha256, mapping_sha256, snapshot_sha256
    FROM migration_batches WHERE id = ?
  `).get(manifest.baselineBatchId);
  if (row === undefined) throw new Error('baseline capacity database does not contain the baseline batch');
}

function databaseMetrics(database) {
  const pageSize = pragma(database, 'page_size');
  const pageCount = pragma(database, 'page_count');
  const freePages = pragma(database, 'freelist_count');
  const tableRows = {};
  for (const row of database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all()) {
    tableRows[row.name] = Number(database.prepare(`SELECT COUNT(*) AS count FROM "${row.name}"`).get().count);
  }
  return {
    pageSize, pageCount, freePages, tableRows,
    databaseBytes: pageSize * pageCount,
    baseRows: Object.values(tableRows).reduce((sum, count) => sum + count, 0),
  };
}

function pragma(database, name) {
  return Number(Object.values(database.prepare(`PRAGMA ${name}`).get())[0]);
}

function sumObjectBytes(objects) {
  return objects.reduce((sum, object) => sum + Number(object.size), 0);
}

async function requireCheckpointedDatabase(path) {
  try {
    const wal = await stat(`${path}-wal`);
    if (wal.size > 0) {
      throw new Error('baseline capacity database has an uncheckpointed WAL file');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function assertMissing(path) {
  try {
    await access(path);
    throw new Error(`output database already exists: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
