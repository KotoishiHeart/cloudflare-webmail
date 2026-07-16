import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { createLegacyInventory, createLegacyMappingTemplate } from '../lib/legacy-inventory.mjs';
import { fetchLegacySnapshot } from '../lib/legacy-snapshot.mjs';
import { prepareLegacyMigrationStage } from '../lib/legacy-stage.mjs';
import { importLegacySafeSql } from '../lib/legacy-sqlite.mjs';
import { verifyMigrationStage } from '../lib/migration-stage.mjs';

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cf-webmail-legacy-stage-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('archived current-format stage', () => {
  it('preserves legacy flags and provenance while rebuilding MIME objects', async () => {
    const rawInbound = inboundEmail();
    const rawOutbound = outboundEmail();
    const sql = join(root, 'safe.sql');
    const database = join(root, 'legacy.sqlite');
    await writeFile(sql, safeSql(rawInbound, rawOutbound));
    await importLegacySafeSql({ sql, database, now: 1000 });
    const inventory = createLegacyInventory(database);
    assert.deepEqual({
      labels: inventory.counts.labels,
      messageLabels: inventory.counts.messageLabels,
      rules: inventory.counts.rules,
      userPreferences: inventory.counts.userPreferences,
    }, { labels: 1, messageLabels: 1, rules: 1, userPreferences: 1 });
    assert.equal(Object.values(inventory.integrity).every((count) => count === 0), true);
    const mapping = createLegacyMappingTemplate(inventory);

    const objectRoot = join(root, 'old-r2');
    await mkdir(join(objectRoot, 'raw'), { recursive: true });
    await writeFile(join(objectRoot, 'raw', 'in.eml.gz'), gzipSync(rawInbound));
    await writeFile(join(objectRoot, 'raw', 'out.eml.gz'), gzipSync(rawOutbound));
    const snapshot = join(root, 'snapshot');
    const snapshotResult = await fetchLegacySnapshot({
      database, mapping, snapshot, objectRoot, concurrency: 2, now: 2000,
    });
    assert.equal(snapshotResult.complete, true);

    const stage = join(root, 'stage');
    const manifest = await prepareLegacyMigrationStage({
      database, mapping, snapshot, stage, now: 3000,
    });
    assert.equal(manifest.version, 3);
    assert.equal(manifest.complete, true);
    assert.deepEqual(manifest.counts, {
      discovered: 2,
      prepared: 2,
      duplicates: 0,
      failed: 0,
      quarantined: 0,
      sourceObjects: 2,
      objects: 5,
    });
    assert.deepEqual(manifest.configuration, {
      source: { labels: 1, messageLabels: 1, rules: 1, preferences: 1 },
      target: { labels: 2, labelSources: 2, messageLabels: 1, rules: 2, preferences: 1 },
    });
    const verified = await verifyMigrationStage(stage);
    assert.equal(verified.objects.length, 5);

    const target = new DatabaseSync(join(root, 'target.sqlite'));
    try {
      target.exec('PRAGMA foreign_keys = ON;');
      for (const name of (await readdir('migrations')).filter((item) => item.endsWith('.sql')).sort()) {
        target.exec(await readFile(`migrations/${name}`, 'utf8'));
      }
      target.prepare(`
        INSERT INTO users (id, email, created_at, updated_at)
        VALUES ('owner-1', 'owner@example.com', 1, 1)
      `).run();
      for (const item of mapping.mappings) {
        target.prepare(`
          INSERT INTO mailboxes (id, display_name, status, created_at, updated_at)
          VALUES (?, ?, 'active', 1, 1)
        `).run(item.mailboxId, item.address);
        target.prepare(`
          INSERT INTO mailbox_memberships (
            mailbox_id, user_id, role, created_at, updated_at
          ) VALUES (?, 'owner-1', 'owner', 1, 1)
        `).run(item.mailboxId);
      }
      for (const sqlFile of manifest.sqlFiles) {
        target.exec(await readFile(join(stage, sqlFile.file), 'utf8'));
      }
      const inbound = target.prepare(`
        SELECT subject, received_at, created_at, is_read, is_starred, is_archived, is_deleted
        FROM messages WHERE direction = 'inbound'
      `).get();
      assert.deepEqual({ ...inbound }, {
        subject: 'Legacy inbound subject',
        received_at: 1111,
        created_at: 1222,
        is_read: 1,
        is_starred: 1,
        is_archived: 1,
        is_deleted: 0,
      });
      const provenance = target.prepare(`
        SELECT source_record_id, source_account, source_direction, source_bcc,
          source_thread_message_id, compose_mode, send_status, provider,
          source_deleted_at, source_created_at
        FROM message_migration_sources WHERE source_record_id = 'old-out'
      `).get();
      assert.deepEqual({ ...provenance }, {
        source_record_id: 'old-out',
        source_account: 'second@example.com',
        source_direction: 'sent',
        source_bcc: 'blind@example.net',
        source_thread_message_id: 'old-in',
        compose_mode: 'reply',
        send_status: 'sent',
        provider: 'smtp2go',
        source_deleted_at: 2444,
        source_created_at: 2333,
      });
      const batch = target.prepare(`
        SELECT expected_messages, source_objects, staged_objects FROM migration_batches
      `).get();
      assert.deepEqual({ ...batch }, { expected_messages: 2, source_objects: 2, staged_objects: 5 });
      assert.deepEqual(configurationCounts(target), {
        labels: 2,
        messageLabels: 1,
        rules: 2,
        ruleLabels: 2,
        preferences: 1,
      });
      const preference = target.prepare(`
        SELECT page_size, compact_layout, default_mailbox_id
        FROM user_preferences WHERE user_id = 'owner-1'
      `).get();
      assert.deepEqual({ ...preference }, {
        page_size: 50,
        compact_layout: 1,
        default_mailbox_id: mapping.mappings[0].mailboxId,
      });
      const rule = target.prepare(`
        SELECT conditions_json, actions_json FROM mail_rules
        WHERE mailbox_id = ?
      `).get(mapping.mappings[0].mailboxId);
      assert.deepEqual(JSON.parse(rule.conditions_json), {
        fromContains: 'billing@example.net',
        toContains: '',
        subjectContains: 'Legacy',
        participantDomain: 'example.net',
        keyword: 'invoice',
        attachment: 'with',
        minimumBytes: 1024,
        maximumBytes: 2048,
        direction: 'inbound',
      });
      assert.deepEqual(JSON.parse(rule.actions_json), {
        star: true,
        archive: false,
        trash: false,
        labelIds: [target.prepare(`
          SELECT id FROM mailbox_labels WHERE mailbox_id = ?
        `).get(mapping.mappings[0].mailboxId).id],
      });
      const provenanceCounts = Object.fromEntries(target.prepare(`
        SELECT source_kind, COUNT(*) AS count FROM migration_configuration_sources
        GROUP BY source_kind ORDER BY source_kind
      `).all().map((row) => [row.source_kind, row.count]));
      assert.deepEqual(provenanceCounts, {
        label: 2,
        mail_rule: 2,
        message_label: 1,
        user_preference: 1,
      });
    } finally {
      target.close();
    }
  });
});

function inboundEmail() {
  return Buffer.from([
    'From: sender@example.net',
    'To: first@example.com',
    'Subject: Raw inbound subject',
    'Message-ID: <inbound@example.net>',
    'Date: Fri, 17 Jul 2026 00:00:00 GMT',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="stage-fixture"',
    '',
    '--stage-fixture',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'inbound body',
    '--stage-fixture',
    'Content-Type: text/plain; name="hello.txt"',
    'Content-Disposition: attachment; filename="hello.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    'aGVsbG8=',
    '--stage-fixture--',
    '',
  ].join('\r\n'));
}

function outboundEmail() {
  return Buffer.from([
    'From: second@example.com',
    'To: recipient@example.net',
    'Subject: Raw outbound subject',
    'Message-ID: <outbound@example.net>',
    'Date: Fri, 17 Jul 2026 00:01:00 GMT',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'outbound body',
    '',
  ].join('\r\n'));
}

function safeSql(rawInbound, rawOutbound) {
  const inbound = messageValues({
    id: 'old-in', direction: 'in', account: 'first@example.com', rawKey: 'raw/in.eml.gz',
    raw: rawInbound, subject: 'Legacy inbound subject', receivedAt: 1111, createdAt: 1222,
    read: 1, starred: 1, archived: 1, deleted: 0, deletedAt: null,
  });
  const outbound = messageValues({
    id: 'old-out', direction: 'sent', account: 'second@example.com', rawKey: 'raw/out.eml.gz',
    raw: rawOutbound, subject: 'Legacy outbound subject', receivedAt: 2222, createdAt: 2333,
    read: 1, starred: 0, archived: 0, deleted: 1, deletedAt: 2444,
    bcc: 'blind@example.net', sourceMessageId: 'old-in', composeMode: 'reply',
    sendStatus: 'sent', provider: 'smtp2go',
  });
  return `-- CF Webmail Starter safe logical backup
PRAGMA foreign_keys=OFF;
-- table: mail_accounts
DELETE FROM "mail_accounts";
INSERT INTO "mail_accounts" ("id", "email", "display_name", "is_active") VALUES (1, 'first@example.com', 'First', 1);
INSERT INTO "mail_accounts" ("id", "email", "display_name", "is_active") VALUES (2, 'second@example.com', 'Second', 1);
-- table: messages
DELETE FROM "messages";
INSERT INTO "messages" (${MESSAGE_COLUMNS.map((column) => `"${column}"`).join(', ')}) VALUES (${inbound});
INSERT INTO "messages" (${MESSAGE_COLUMNS.map((column) => `"${column}"`).join(', ')}) VALUES (${outbound});
-- table: blobs
DELETE FROM "blobs";
INSERT INTO "blobs" ("sha256", "size", "content_type", "storage_key", "filename_hint", "ref_count", "created_at") VALUES ('${hash(Buffer.from('hello'))}', 5, 'text/plain', 'attach/hello', 'hello.txt', 1, 1222);
-- table: attachments
DELETE FROM "attachments";
INSERT INTO "attachments" ("id", "message_id", "blob_sha256", "filename", "content_type", "size") VALUES (1, 'old-in', '${hash(Buffer.from('hello'))}', 'hello.txt', 'text/plain', 5);
-- table: labels
DELETE FROM "labels";
INSERT INTO "labels" ("id", "name", "color", "description", "created_at", "updated_at") VALUES (1, 'Important', '#2563eb', 'Legacy label', 1200, 1300);
-- table: message_labels
DELETE FROM "message_labels";
INSERT INTO "message_labels" ("message_id", "label_id", "source_rule_id", "created_at") VALUES ('old-in', 1, 'rule-old', 1400);
-- table: mail_rules
DELETE FROM "mail_rules";
INSERT INTO "mail_rules" ("id", "name", "enabled", "priority", "match_json", "action_json", "apply_existing", "apply_incoming", "last_preview_count", "last_preview_at", "last_run_at", "created_at", "updated_at") VALUES ('rule-old', 'Legacy filing', 1, 20, '{"from":"billing@example.net","subject":"Legacy","domain":"example.net","keyword":"invoice","has_attachments":"yes","min_size_kb":1,"max_size_kb":2,"direction":"in"}', '{"star":true,"archive":false,"trash":false,"label":"Important"}', 1, 1, 1, 1500, 1600, 1450, 1600);
-- table: app_settings
DELETE FROM "app_settings";
INSERT INTO "app_settings" ("key", "value", "updated_at") VALUES ('user_pref:owner@example.com', '{"default_account":"first@example.com","page_size":100,"dense_list":true}', 1700);
PRAGMA foreign_keys=ON;
`;
}

function configurationCounts(database) {
  const count = (table) => database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  return {
    labels: count('mailbox_labels'),
    messageLabels: count('message_labels'),
    rules: count('mail_rules'),
    ruleLabels: count('mail_rule_labels'),
    preferences: count('user_preferences'),
  };
}

const MESSAGE_COLUMNS = [
  'id', 'direction', 'message_id', 'raw_sha256', 'subject', 'sender', 'recipients', 'cc',
  'date_header', 'received_at', 'text_preview', 'raw_key', 'body_text_key', 'body_html_key',
  'size', 'has_attachments', 'archived', 'compressed', 'created_at', 'is_read', 'starred',
  'deleted', 'deleted_at', 'account_email', 'bcc', 'in_reply_to', 'references_header',
  'source_message_id', 'compose_mode', 'send_status', 'provider',
];

function messageValues(input) {
  const inbound = input.direction === 'in';
  return [
    input.id, input.direction, inbound ? '<inbound@example.net>' : '<outbound@example.net>',
    hash(input.raw), input.subject, inbound ? 'sender@example.net' : input.account,
    inbound ? input.account : 'recipient@example.net', '', 'legacy date', input.receivedAt,
    'legacy preview', input.rawKey, '', '', input.raw.byteLength, inbound ? 1 : 0,
    input.archived, 1, input.createdAt, input.read, input.starred, input.deleted,
    input.deletedAt, input.account, input.bcc ?? '', inbound ? '' : '<inbound@example.net>',
    inbound ? '' : '<inbound@example.net>', input.sourceMessageId ?? '', input.composeMode ?? '',
    input.sendStatus ?? '', input.provider ?? '',
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
