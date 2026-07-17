import { access, chmod, readFile, readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stageSha256 } from './legacy-bulk-stage.mjs';
import { verifyMigrationStage } from './migration-stage.mjs';
import { validateProvisionManifest } from './ops-manifest.mjs';
import { renderProvisionSql } from './ops-sql.mjs';

const D1_FREE_DATABASE_BYTES = 500_000_000;
const D1_FREE_DAILY_ROWS_WRITTEN = 100_000;
const R2_FREE_STORAGE_BYTES = 10_000_000_000;
const R2_FREE_MONTHLY_CLASS_A = 1_000_000;
const OWNER_ID = '019c6f3c-6260-7000-8000-000000000001';

export async function rehearseLegacyCapacity(stageInput, databaseInput, options = {}) {
  const stage = resolve(stageInput);
  const databasePath = resolve(databaseInput);
  const migrations = resolve(options.migrations ?? 'migrations');
  const now = options.now ?? Date.now();
  await assertMissing(databasePath);
  const verified = await verifyMigrationStage(stage);
  if (verified.manifest.version !== 3 || verified.manifest.complete !== true) {
    throw new Error('capacity rehearsal requires a complete archived migration stage');
  }
  let database;
  try {
    database = new DatabaseSync(databasePath);
    await chmod(databasePath, 0o600);
    database.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF; PRAGMA foreign_keys = ON;');
    for (const name of (await readdir(migrations)).filter(sqlFile).sort()) {
      database.exec(await readFile(resolve(migrations, name), 'utf8'));
    }
    if (typeof options.provisioning === 'string') {
      const provisioning = validateProvisionManifest(
        JSON.parse(await readFile(resolve(options.provisioning), 'utf8')),
      );
      database.exec(renderProvisionSql(provisioning, now));
    } else {
      provisionCapacityDirectory(database, verified.manifest, now);
    }
    for (const descriptor of verified.manifest.sqlFiles) {
      try {
        database.exec(await readFile(resolve(stage, descriptor.file), 'utf8'));
      } catch (error) {
        throw new Error(
          `capacity rehearsal failed at ${descriptor.file}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    const tableRows = countTableRows(database);
    const pageSize = pragmaNumber(database, 'page_size');
    const pageCount = pragmaNumber(database, 'page_count');
    const freePages = pragmaNumber(database, 'freelist_count');
    const databaseBytes = pageSize * pageCount;
    const baseRows = Object.values(tableRows).reduce((total, value) => total + value, 0);
    const r2Bytes = verified.objects.reduce((total, object) => total + Number(object.size), 0);
    const result = {
      version: 1,
      kind: 'cf-webmail-legacy-capacity-rehearsal',
      createdAt: now,
      batchId: verified.manifest.batchId,
      stageSha256: stageSha256(verified.manifest, verified.objects),
      counts: {
        messages: tableRows.messages ?? 0,
        attachments: tableRows.attachments ?? 0,
        searchDocuments: tableRows.message_search_documents ?? 0,
        migrationSources: tableRows.message_migration_sources ?? 0,
        tables: Object.keys(tableRows).length,
        baseRows,
        r2Objects: verified.objects.length,
        r2Bytes,
      },
      sqlite: { databaseBytes, pageSize, pageCount, freePages },
      freePlan: {
        limitsAsOf: '2026-04-21',
        d1DatabaseBytes: D1_FREE_DATABASE_BYTES,
        d1DailyRowsWritten: D1_FREE_DAILY_ROWS_WRITTEN,
        r2StorageBytes: R2_FREE_STORAGE_BYTES,
        r2MonthlyClassAOperations: R2_FREE_MONTHLY_CLASS_A,
        d1DatabaseFits: databaseBytes <= D1_FREE_DATABASE_BYTES,
        minimumBaseRowWriteDays: Math.ceil(baseRows / D1_FREE_DAILY_ROWS_WRITTEN),
        r2StorageFits: r2Bytes <= R2_FREE_STORAGE_BYTES,
        r2InitialWritesFit: verified.objects.length <= R2_FREE_MONTHLY_CLASS_A,
      },
    };
    database.close();
    return result;
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

function provisionCapacityDirectory(database, manifest, now) {
  database.prepare(`
    INSERT INTO users (id, email, display_name, status, created_at, updated_at)
    VALUES (?, 'capacity-rehearsal@example.invalid', 'Capacity rehearsal', 'active', ?, ?)
  `).run(OWNER_ID, now, now);
  const mailbox = database.prepare(`
    INSERT INTO mailboxes (id, display_name, status, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?)
  `);
  const membership = database.prepare(`
    INSERT INTO mailbox_memberships (mailbox_id, user_id, role, created_at, updated_at)
    VALUES (?, ?, 'owner', ?, ?)
  `);
  const address = database.prepare(`
    INSERT INTO mailbox_addresses (address, mailbox_id, kind, status, created_at, updated_at)
    VALUES (?, ?, 'primary', 'active', ?, ?)
  `);
  database.exec('BEGIN IMMEDIATE;');
  try {
    for (const mapping of manifest.mappings) {
      mailbox.run(mapping.mailboxId, 'Capacity rehearsal mailbox', now, now);
      membership.run(mapping.mailboxId, OWNER_ID, now, now);
      address.run(mapping.address, mapping.mailboxId, now, now);
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

function countTableRows(database) {
  const result = {};
  const tables = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all();
  for (const row of tables) {
    const name = String(row.name);
    if (!/^[a-z][a-z0-9_]*$/u.test(name)) throw new Error('capacity schema has an unsafe table name');
    result[name] = Number(database.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count);
  }
  return result;
}

function pragmaNumber(database, name) {
  return Number(database.prepare(`PRAGMA ${name}`).get()[name]);
}

function sqlFile(name) {
  return /^\d{4}_[a-z0-9_]+\.sql$/u.test(name);
}

async function assertMissing(path) {
  try {
    await access(path);
    throw new Error(`capacity rehearsal database already exists: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
