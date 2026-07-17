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
import { auditLegacyDeltaTarget } from '../lib/legacy-delta-bulk-audit.mjs';
import { rehearseLegacyDeltaCapacity } from '../lib/legacy-delta-capacity.mjs';

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

    const capacityBaseline = new DatabaseSync(join(root, 'capacity-baseline.sqlite'));
    capacityBaseline.exec('PRAGMA foreign_keys = ON;');
    for (const name of (await readdir('migrations')).filter((item) => item.endsWith('.sql')).sort()) {
      capacityBaseline.exec(await readFile(`migrations/${name}`, 'utf8'));
    }
    provision(capacityBaseline, baseline.mapping);
    applySqlStage(capacityBaseline, baselineStage, baselineManifest);
    capacityBaseline.close();
    const capacityDatabase = join(root, 'capacity-final.sqlite');
    const capacity = await rehearseLegacyDeltaCapacity({
      baselineDatabase: join(root, 'capacity-baseline.sqlite'),
      baselineStage,
      stage: deltaStage,
      database: capacityDatabase,
      now: 5500,
    });
    assert.equal(capacity.counts.finalTableRows.messages, 3);
    assert.equal(capacity.freePlan.d1DatabaseFits, true);
    assert.equal((await stat(capacityDatabase)).mode & 0o777, 0o600);

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

  it('creates a valid object-free delta when only flags changed', async () => {
    const baseline = await legacySource('flags-baseline', [
      legacyMessage('flags-1', 'first@example.com', 'raw/flags.eml.gz', rawOne),
    ]);
    const baselineStage = join(root, 'flags-baseline-stage');
    await prepareLegacyMigrationStage({
      database: baseline.database, mapping: baseline.mapping,
      snapshot: baseline.snapshot, stage: baselineStage,
    });
    const final = await legacySource('flags-final', [
      legacyMessage('flags-1', 'first@example.com', 'raw/flags.eml.gz', rawOne, { starred: 1 }),
    ], { seed: baseline });
    const delta = await prepareLegacyDeltaStage({
      baselineDatabase: baseline.database, baselineStage,
      database: final.database, mapping: final.mapping, snapshot: final.snapshot,
      stage: join(root, 'flags-delta-stage'),
    });
    assert.equal(delta.messageBatchId, null);
    assert.equal(delta.counts.newMessages, 0);
    assert.equal(delta.counts.flagUpdates, 1);
    assert.equal(delta.counts.objects, 0);
    assert.equal((await verifyMigrationStage(join(root, 'flags-delta-stage'))).objects.length, 0);
  });

  it('synchronizes inserted, updated, and deleted legacy configuration', async () => {
    const baseline = await legacySource('configuration-baseline', [
      legacyMessage('config-1', 'first@example.com', 'raw/config-1.eml.gz', rawOne),
      legacyMessage('config-2', 'second@example.com', 'raw/config-2.eml.gz', rawTwo),
    ], { configuration: baselineConfiguration() });
    const baselineStage = join(root, 'configuration-baseline-stage');
    const baselineManifest = await prepareLegacyMigrationStage({
      database: baseline.database, mapping: baseline.mapping,
      snapshot: baseline.snapshot, stage: baselineStage, now: 6000,
    });
    const final = await legacySource('configuration-final', [
      legacyMessage('config-1', 'first@example.com', 'raw/config-1.eml.gz', rawOne),
      legacyMessage('config-2', 'second@example.com', 'raw/config-2.eml.gz', rawTwo),
      legacyMessage('config-3', 'first@example.com', 'raw/config-3.eml.gz', rawThree),
    ], { seed: baseline, configuration: finalConfiguration() });
    const deltaStage = join(root, 'configuration-delta-stage');
    const delta = await prepareLegacyDeltaStage({
      baselineDatabase: baseline.database, baselineStage,
      database: final.database, mapping: final.mapping, snapshot: final.snapshot,
      stage: deltaStage, now: 7000,
    });
    assert.equal(delta.counts.newMessages, 1);
    assert.equal(delta.counts.configurationMutations, 18);
    assert.deepEqual(delta.configuration.counts, {
      label: { insert: 2, update: 2, delete: 2 },
      message_label: { insert: 1, update: 1, delete: 1 },
      mail_rule: { insert: 2, update: 2, delete: 2 },
      user_preference: { insert: 1, update: 1, delete: 1 },
    });
    const target = new DatabaseSync(join(root, 'configuration-target.sqlite'));
    try {
      target.exec('PRAGMA foreign_keys = ON;');
      for (const name of (await readdir('migrations')).filter((item) => item.endsWith('.sql')).sort()) {
        target.exec(await readFile(`migrations/${name}`, 'utf8'));
      }
      provision(target, baseline.mapping);
      applySqlStage(target, baselineStage, baselineManifest);
      applySqlStage(target, deltaStage, delta);
      applySqlStage(target, deltaStage, delta);
      assert.deepEqual(configurationCounts(target), {
        labels: 4, messageLabels: 2, rules: 4, ruleLabels: 4, preferences: 2,
      });
      assert.equal(target.prepare(`
        SELECT COUNT(*) AS count FROM mailbox_labels WHERE name = 'Remove'
      `).get().count, 0);
      assert.equal(target.prepare(`
        SELECT COUNT(*) AS count FROM mailbox_labels WHERE name = 'Keep' AND color = '#334455'
      `).get().count, 2);
      const preference = target.prepare(`
        SELECT p.page_size, p.compact_layout, a.address AS default_address
        FROM user_preferences AS p
        JOIN mailbox_addresses AS a ON a.mailbox_id = p.default_mailbox_id
        WHERE p.user_id = 'owner-1' AND a.kind = 'primary'
      `).get();
      assert.deepEqual({ ...preference }, {
        page_size: 50, compact_layout: 1, default_address: 'second@example.com',
      });
      assert.equal(target.prepare(`
        SELECT COUNT(*) AS count FROM legacy_migration_delta_sources
        WHERE delta_id = ? AND source_kind IN ('label', 'message_label', 'mail_rule', 'user_preference')
      `).get(delta.deltaId).count, 18);
      const audit = auditLegacyDeltaTarget(delta, {
        local: true, remote: false, database: 'cf-webmail', config: 'apps/web/wrangler.jsonc',
      }, sqliteQueryRunner(target));
      assert.equal(audit.configurationMutations, 18);
      assert.equal(audit.newMessages, 1);
    } finally {
      target.close();
    }
  });
});

async function legacySource(name, messages, options = {}) {
  const sql = join(root, `${name}.sql`);
  const database = join(root, `${name}.sqlite`);
  await writeFile(sql, safeSql(messages, options.configuration));
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
  database.prepare(`
    INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, 1, 1)
  `).run('preference-remove', 'remove@example.com');
  database.prepare(`
    INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, 1, 1)
  `).run('preference-new', 'new@example.com');
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
      INSERT INTO mailbox_memberships (mailbox_id, user_id, role, created_at, updated_at)
      VALUES (?, ?, 'viewer', 1, 1)
    `).run(item.mailboxId, 'preference-remove');
    database.prepare(`
      INSERT INTO mailbox_memberships (mailbox_id, user_id, role, created_at, updated_at)
      VALUES (?, ?, 'viewer', 1, 1)
    `).run(item.mailboxId, 'preference-new');
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
    id, account, rawKey, raw, read: changes.read ?? 0, starred: changes.starred ?? 0, archived: 0,
    deleted: changes.deleted ?? 0, deletedAt: changes.deletedAt ?? null,
    subject: changes.subject ?? `Legacy ${id}`,
  };
}

function safeSql(messages, configuration) {
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
${configuration === undefined ? '' : configurationSql(configuration)}
PRAGMA foreign_keys=ON;
`;
}

function configurationSql(configuration) {
  return `-- table: labels
DELETE FROM "labels";
${configuration.labels.map((item) => `INSERT INTO "labels" ("id", "name", "color", "description", "created_at", "updated_at") VALUES (${sqlValue(item.id)}, ${sqlValue(item.name)}, ${sqlValue(item.color)}, '', ${item.createdAt}, ${item.updatedAt});`).join('\n')}
-- table: message_labels
DELETE FROM "message_labels";
${configuration.messageLabels.map((item) => `INSERT INTO "message_labels" ("message_id", "label_id", "source_rule_id", "created_at") VALUES (${sqlValue(item.messageId)}, ${sqlValue(item.labelId)}, ${sqlValue(item.sourceRuleId)}, ${item.createdAt});`).join('\n')}
-- table: mail_rules
DELETE FROM "mail_rules";
${configuration.rules.map((item) => `INSERT INTO "mail_rules" ("id", "name", "enabled", "priority", "match_json", "action_json", "apply_existing", "apply_incoming", "last_preview_count", "last_preview_at", "last_run_at", "created_at", "updated_at") VALUES (${sqlValue(item.id)}, ${sqlValue(item.name)}, ${item.enabled}, ${item.priority}, ${sqlValue(JSON.stringify(item.match))}, ${sqlValue(JSON.stringify(item.action))}, 1, 1, 0, NULL, NULL, ${item.createdAt}, ${item.updatedAt});`).join('\n')}
-- table: app_settings
DELETE FROM "app_settings";
${configuration.preferences.map((item) => `INSERT INTO "app_settings" ("key", "value", "updated_at") VALUES (${sqlValue(`user_pref:${item.email}`)}, ${sqlValue(JSON.stringify(item.value))}, ${item.updatedAt});`).join('\n')}
`;
}

function baselineConfiguration() {
  return {
    labels: [label(1, 'Keep', '#112233'), label(2, 'Remove', '#223344')],
    rules: [
      rule('rule-1', 'Keep rule', 'Keep', 1, 10),
      rule('rule-2', 'Remove rule', 'Remove', 1, 20),
    ],
    messageLabels: [
      { messageId: 'config-1', labelId: 2, sourceRuleId: 'rule-2', createdAt: 2600 },
      { messageId: 'config-2', labelId: 1, sourceRuleId: 'rule-1', createdAt: 2700 },
    ],
    preferences: [
      {
        email: 'owner@example.com',
        value: { default_account: 'first@example.com', page_size: 25, dense_list: false },
        updatedAt: 2800,
      },
      {
        email: 'remove@example.com',
        value: { default_account: 'first@example.com', page_size: 25, dense_list: false },
        updatedAt: 2850,
      },
    ],
  };
}

function finalConfiguration() {
  return {
    labels: [label(1, 'Keep', '#334455', 3100), label(3, 'New', '#445566', 3200)],
    rules: [
      rule('rule-1', 'Keep rule changed', 'New', 0, 10, 3300),
      rule('rule-3', 'New rule', 'Keep', 1, 30, 3400),
    ],
    messageLabels: [
      { messageId: 'config-2', labelId: 1, sourceRuleId: 'rule-3', createdAt: 3500 },
      { messageId: 'config-3', labelId: 3, sourceRuleId: 'rule-1', createdAt: 3600 },
    ],
    preferences: [
      {
        email: 'owner@example.com',
        value: { default_account: 'second@example.com', page_size: 50, dense_list: true },
        updatedAt: 3700,
      },
      {
        email: 'new@example.com',
        value: { default_account: 'first@example.com', page_size: 25, dense_list: false },
        updatedAt: 3750,
      },
    ],
  };
}

function label(id, name, color, updatedAt = 2500) {
  return { id, name, color, createdAt: 2400, updatedAt };
}

function rule(id, name, actionLabel, enabled, priority, updatedAt = 2500) {
  return {
    id, name, enabled, priority, match: { subject: name },
    action: { star: true, label: actionLabel }, createdAt: 2400, updatedAt,
  };
}

function configurationCounts(database) {
  const count = (table) => database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  return {
    labels: count('mailbox_labels'), messageLabels: count('message_labels'),
    rules: count('mail_rules'), ruleLabels: count('mail_rule_labels'),
    preferences: count('user_preferences'),
  };
}

function sqliteQueryRunner(database) {
  return {
    spawn(_command, args) {
      const sql = args[args.indexOf('--command') + 1];
      return {
        status: 0,
        stdout: JSON.stringify([{ results: database.prepare(sql).all() }]),
        stderr: '',
      };
    },
  };
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
