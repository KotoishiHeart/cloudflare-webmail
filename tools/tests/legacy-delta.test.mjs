import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { createLegacyInventory, createLegacyMappingTemplate } from '../lib/legacy-inventory.mjs';
import { importLegacySafeSql } from '../lib/legacy-sqlite.mjs';
import { fetchLegacySnapshot } from '../lib/legacy-snapshot.mjs';
import { prepareLegacyMigrationStage } from '../lib/legacy-stage.mjs';
import { prepareLegacyDeltaStage } from '../lib/legacy-delta-stage.mjs';
import { verifyMigrationStage } from '../lib/migration-stage.mjs';

let root;
const rawOne = rawEmail('One', '<one@example.net>');
const rawTwo = rawEmail('Two', '<two@example.net>');
const rawThree = rawEmail('Three', '<three@example.net>');

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cf-webmail-legacy-delta-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('archived baseline and final delta stage', () => {
  it('adds only new messages and synchronizes mutable flags', async () => {
    const baseline = await legacySource('baseline', [
      legacyMessage('old-1', 'first@example.com', 'raw/one.eml.gz', rawOne),
      legacyMessage('old-2', 'second@example.com', 'raw/two.eml.gz', rawTwo, { read: 1 }),
    ]);
    const baselineStage = join(root, 'baseline-stage');
    const baselineManifest = await prepareLegacyMigrationStage({
      database: baseline.database,
      mapping: baseline.mapping,
      snapshot: baseline.snapshot,
      stage: baselineStage,
      now: 3000,
    });
    const final = await legacySource('final', [
      legacyMessage('old-1', 'first@example.com', 'raw/one.eml.gz', rawOne, {
        read: 1, deleted: 1, deletedAt: 4500,
      }),
      legacyMessage('old-2', 'second@example.com', 'raw/two.eml.gz', rawTwo, { read: 1 }),
      legacyMessage('old-3', 'first@example.com', 'raw/three.eml.gz', rawThree),
    ], { seed: baseline });
    const deltaStage = join(root, 'delta-stage');
    const delta = await prepareLegacyDeltaStage({
      baselineDatabase: baseline.database,
      baselineStage,
      database: final.database,
      mapping: final.mapping,
      snapshot: final.snapshot,
      stage: deltaStage,
      now: 5000,
    });
    assert.equal(delta.version, 4);
    assert.equal(delta.baselineBatchId, baselineManifest.batchId);
    assert.deepEqual(delta.counts, {
      baselineMessages: 2,
      finalMessages: 3,
      newMessages: 1,
      flagUpdates: 1,
      configurationMutations: 0,
      changes: 2,
      failed: 0,
      quarantined: 0,
      sourceObjects: 1,
      objects: 2,
    });
    const verified = await verifyMigrationStage(deltaStage);
    assert.equal(verified.changes.length, 2);
    assert.equal((await stat(deltaStage)).mode & 0o777, 0o700);
    assert.equal((await stat(join(deltaStage, 'changes.jsonl'))).mode & 0o777, 0o600);

    const target = new DatabaseSync(join(root, 'target.sqlite'));
    try {
      target.exec('PRAGMA foreign_keys = ON;');
      for (const name of (await readdir('migrations')).filter((item) => item.endsWith('.sql')).sort()) {
        target.exec(await readFile(`migrations/${name}`, 'utf8'));
      }
      provision(target, baseline.mapping);
      applySqlStage(target, baselineStage, baselineManifest);
      applySqlStage(target, deltaStage, delta);
      applySqlStage(target, deltaStage, delta);
      assert.equal(target.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 3);
      const changed = target.prepare(`
        SELECT is_read, is_deleted FROM messages WHERE raw_sha256 = ?
      `).get(hash(rawOne));
      assert.deepEqual({ ...changed }, { is_read: 1, is_deleted: 1 });
      const provenance = target.prepare(`
        SELECT source_deleted_at FROM message_migration_sources
        WHERE batch_id = ? AND source_record_id = 'old-1'
      `).get(baselineManifest.batchId);
      assert.deepEqual({ ...provenance }, { source_deleted_at: 4500 });
      const audit = target.prepare(`
        SELECT expected_new_messages, expected_flag_updates, expected_changes
        FROM legacy_migration_deltas WHERE id = ?
      `).get(delta.deltaId);
      assert.deepEqual({ ...audit }, {
        expected_new_messages: 1, expected_flag_updates: 1, expected_changes: 2,
      });
      assert.equal(target.prepare(`
        SELECT COUNT(*) AS count FROM legacy_migration_delta_sources WHERE delta_id = ?
      `).get(delta.deltaId).count, 2);
    } finally {
      target.close();
    }
  });

  it('rejects an unexpected mutation of baseline message content', async () => {
    const baseline = await legacySource('immutable-baseline', [
      legacyMessage('old-immutable', 'first@example.com', 'raw/immutable.eml.gz', rawOne),
    ]);
    const baselineStage = join(root, 'immutable-baseline-stage');
    await prepareLegacyMigrationStage({
      database: baseline.database, mapping: baseline.mapping,
      snapshot: baseline.snapshot, stage: baselineStage,
    });
    const changed = await legacySource('immutable-final', [
      legacyMessage('old-immutable', 'first@example.com', 'raw/immutable.eml.gz', rawOne, {
        subject: 'Changed subject',
      }),
    ]);
    const stage = join(root, 'immutable-delta-stage');
    await assert.rejects(prepareLegacyDeltaStage({
      baselineDatabase: baseline.database,
      baselineStage,
      database: changed.database,
      mapping: changed.mapping,
      snapshot: changed.snapshot,
      stage,
    }), /changed immutable field\(s\): subject/u);
    await assert.rejects(stat(stage), /ENOENT/u);
  });
});

async function legacySource(name, messages, options = {}) {
  const sql = join(root, `${name}.sql`);
  const database = join(root, `${name}.sqlite`);
  await writeFile(sql, safeSql(messages));
  await importLegacySafeSql({ sql, database, now: 1000 });
  const mapping = createLegacyMappingTemplate(createLegacyInventory(database));
  const objectRoot = join(root, `${name}-r2`);
  for (const message of messages) {
    if (options.seed && options.seed.keys.has(message.rawKey)) continue;
    await mkdir(join(objectRoot, 'raw'), { recursive: true });
    await writeFile(join(objectRoot, message.rawKey), gzipSync(message.raw));
  }
  const snapshot = join(root, `${name}-snapshot`);
  await fetchLegacySnapshot({
    database, mapping, snapshot, objectRoot,
    ...(options.seed ? {
      seedSnapshot: options.seed.snapshot,
      seedMapping: options.seed.mapping,
    } : {}),
  });
  return { database, mapping, snapshot, keys: new Set(messages.map((item) => item.rawKey)) };
}

function applySqlStage(database, stage, manifest) {
  for (const descriptor of manifest.sqlFiles) {
    database.exec(readFileSync(join(stage, descriptor.file), 'utf8'));
  }
}

function provision(database, mapping) {
  database.prepare(`
    INSERT INTO users (id, email, created_at, updated_at) VALUES ('owner-1', 'owner@example.com', 1, 1)
  `).run();
  for (const item of mapping.mappings) {
    database.prepare(`
      INSERT INTO mailboxes (id, display_name, status, created_at, updated_at)
      VALUES (?, ?, 'active', 1, 1)
    `).run(item.mailboxId, item.address);
    database.prepare(`
      INSERT INTO mailbox_memberships (mailbox_id, user_id, role, created_at, updated_at)
      VALUES (?, 'owner-1', 'owner', 1, 1)
    `).run(item.mailboxId);
    database.prepare(`
      INSERT INTO mailbox_addresses (address, mailbox_id, kind, status, created_at, updated_at)
      VALUES (?, ?, 'primary', 'active', 1, 1)
    `).run(item.address, item.mailboxId);
  }
}

function rawEmail(subject, messageId) {
  return Buffer.from([
    'From: sender@example.net', 'To: mailbox@example.com', `Subject: ${subject}`,
    `Message-ID: ${messageId}`, 'Date: Fri, 17 Jul 2026 00:00:00 GMT',
    'Content-Type: text/plain; charset=UTF-8', '', `${subject} body`, '',
  ].join('\r\n'));
}

function legacyMessage(id, account, rawKey, raw, changes = {}) {
  return {
    id, account, rawKey, raw, read: changes.read ?? 0, starred: 0, archived: 0,
    deleted: changes.deleted ?? 0, deletedAt: changes.deletedAt ?? null,
    subject: changes.subject ?? `Legacy ${id}`,
  };
}

function safeSql(messages) {
  const accounts = [...new Set(messages.map((message) => message.account))];
  return `-- CF Webmail Starter safe logical backup
PRAGMA foreign_keys=OFF;
-- table: mail_accounts
DELETE FROM "mail_accounts";
${accounts.map((account, index) => `INSERT INTO "mail_accounts" ("id", "email") VALUES (${index + 1}, '${account}');`).join('\n')}
-- table: messages
DELETE FROM "messages";
${messages.map((message, index) => `INSERT INTO "messages" (${MESSAGE_COLUMNS.map((column) => `"${column}"`).join(', ')}) VALUES (${messageValues(message, 2000 + index)});`).join('\n')}
-- table: blobs
DELETE FROM "blobs";
-- table: attachments
DELETE FROM "attachments";
PRAGMA foreign_keys=ON;
`;
}

const MESSAGE_COLUMNS = [
  'id', 'direction', 'message_id', 'raw_sha256', 'subject', 'sender', 'recipients', 'cc',
  'date_header', 'received_at', 'text_preview', 'raw_key', 'body_text_key', 'body_html_key',
  'size', 'has_attachments', 'archived', 'compressed', 'created_at', 'is_read', 'starred',
  'deleted', 'deleted_at', 'account_email', 'bcc', 'in_reply_to', 'references_header',
  'source_message_id', 'compose_mode', 'send_status', 'provider',
];

function messageValues(message, time) {
  return [
    message.id, 'in', `<${message.id}@example.net>`, hash(message.raw), message.subject,
    'sender@example.net', message.account, '', 'legacy date', time, 'legacy preview',
    message.rawKey, '', '', message.raw.byteLength, 0, message.archived, 1, time,
    message.read, message.starred, message.deleted, message.deletedAt, message.account,
    '', '', '', '', '', '', '',
  ].map(sqlValue).join(', ');
}

function sqlValue(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
