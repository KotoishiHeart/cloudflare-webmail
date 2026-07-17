import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve('.');
const SOURCE_ROOTS = [
  'apps/web/src',
  'apps/web/public/ui',
  'apps/ingest/src',
  'apps/jobs/src',
  'packages/contracts/src',
  'packages/database/src',
  'tools/lib',
];
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.ts']);
const MAX_SOURCE_LINES = 250;

test('production modules keep bounded responsibilities', async () => {
  const files = (await Promise.all(SOURCE_ROOTS.map((root) => sourceFiles(root)))).flat();
  files.push('apps/web/public/app.js', 'apps/web/public/service-worker.js');
  const oversized = [];
  for (const path of files) {
    const source = await readFile(path, 'utf8');
    const lines = physicalLineCount(source);
    if (lines > MAX_SOURCE_LINES) oversized.push(`${path}: ${lines}`);
  }
  assert.equal(files.length > 100, true, 'the architecture scan unexpectedly found too few files');
  assert.deepEqual(
    oversized,
    [],
    `split modules above ${MAX_SOURCE_LINES} lines by responsibility`,
  );
});

test('git ignore policy covers local credentials and generated operator data', async () => {
  const ignored = new Set(
    (await readFile('.gitignore', 'utf8')).split(/\r?\n/gu).filter(Boolean),
  );
  for (const path of ['.dev.vars', '.dev.vars.*', '.env', '.env.*', '.generated/', '/ops/']) {
    assert.equal(ignored.has(path), true, `${path} must remain ignored`);
  }
});

test('workspace and lockfile package versions cannot drift', async () => {
  const paths = [
    'package.json',
    'apps/web/package.json',
    'apps/ingest/package.json',
    'apps/jobs/package.json',
    'packages/contracts/package.json',
    'packages/database/package.json',
  ];
  const manifests = await Promise.all(paths.map(async (path) => (
    JSON.parse(await readFile(path, 'utf8'))
  )));
  const releaseVersion = manifests[0].version;
  assert.match(releaseVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  for (const [index, manifest] of manifests.entries()) {
    assert.equal(manifest.version, releaseVersion, `${paths[index]} version drifted`);
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith('@cf-webmail/')) {
        assert.equal(version, releaseVersion, `${paths[index]} dependency ${name} drifted`);
      }
    }
  }
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  assert.equal(lock.version, releaseVersion);
  for (const path of paths) {
    const key = path === 'package.json' ? '' : path.slice(0, -'/package.json'.length);
    assert.equal(lock.packages[key].version, releaseVersion, `lockfile ${key || 'root'} drifted`);
  }
});

test('ordered migrations create the complete schema from an empty database', async () => {
  const migrationNames = (await readdir('migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.equal(migrationNames.length, 17);
  migrationNames.forEach((name, index) => {
    assert.match(name, new RegExp(`^${String(index + 1).padStart(4, '0')}_`, 'u'));
  });

  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    for (const name of migrationNames) {
      database.exec(await readFile(join('migrations', name), 'utf8'));
    }
    const tables = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(tables, EXPECTED_TABLES);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});

test('completion docs preserve the parity and remote-evidence boundaries', async () => {
  const [parity, readiness] = await Promise.all([
    readFile('docs/legacy-parity.md', 'utf8'),
    readFile('docs/release-readiness.md', 'utf8'),
  ]);
  for (const status of ['Rebuilt', 'Replaced', 'External', 'Excluded']) {
    assert.match(parity, new RegExp(`\\*\\*${status}\\*\\*`, 'u'));
  }
  assert.match(parity, /250 physical lines/u);
  assert.match(readiness, /npm run test:workers/u);
  assert.match(readiness, /cutoverReady: false/u);
  assert.match(readiness, /remote deployment not yet proven/u);
});

async function sourceFiles(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await sourceFiles(path));
    if (entry.isFile() && SOURCE_EXTENSIONS.has(extension(entry.name))) {
      output.push(relative(ROOT, resolve(path)));
    }
  }
  return output;
}

function extension(name) {
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index);
}

function physicalLineCount(source) {
  if (source === '') return 0;
  const newlines = source.match(/\n/gu)?.length ?? 0;
  return newlines + (source.endsWith('\n') ? 0 : 1);
}

const EXPECTED_TABLES = [
  'access_identities',
  'attachments',
  'audit_events',
  'delivery_events',
  'inbound_handoffs',
  'legacy_migration_delta_sources',
  'legacy_migration_deltas',
  'mail_rule_labels',
  'mail_rule_run_matches',
  'mail_rule_runs',
  'mail_rules',
  'mailbox_addresses',
  'mailbox_labels',
  'mailbox_memberships',
  'mailboxes',
  'maintenance_cursors',
  'message_labels',
  'message_migration_sources',
  'message_search_documents',
  'messages',
  'migration_batches',
  'migration_configuration_sources',
  'outbound_compositions',
  'outbound_deliveries',
  'outbound_recipients',
  'queue_dead_letters',
  'retention_policies',
  'retention_run_items',
  'retention_runs',
  'storage_issues',
  'system_administrators',
  'user_preferences',
  'users',
];
