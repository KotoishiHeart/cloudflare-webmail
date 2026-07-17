import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createLegacyInventory,
  createLegacyMappingTemplate,
  legacyMappingSha256,
  loadAndValidateLegacyMapping,
} from '../lib/legacy-inventory.mjs';
import { runLegacyMigrationCli } from '../lib/legacy-cli.mjs';
import { createLegacyProvisioningDraft } from '../lib/legacy-provisioning.mjs';
import { importLegacySafeSql } from '../lib/legacy-sqlite.mjs';

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cf-webmail-legacy-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('archived SQL isolation', () => {
  it('imports only safe-backup statements and produces account inventory', async () => {
    const sql = join(root, 'safe.sql');
    const database = join(root, 'legacy.sqlite');
    await writeFile(sql, fixtureSql());
    const imported = await importLegacySafeSql({ sql, database, now: 1234 });
    assert.equal(imported.inserted.messages, 2);
    assert.match(imported.source.sha256, /^[0-9a-f]{64}$/u);

    const inventory = createLegacyInventory(database, 2345);
    assert.equal(inventory.createdAt, 2345);
    assert.deepEqual(inventory.counts, {
      messages: 2,
      inbound: 1,
      outbound: 1,
      attachments: 1,
      blobs: 1,
      r2References: 6,
      uniqueR2Objects: 6,
      labels: 0,
      messageLabels: 0,
      rules: 0,
      userPreferences: 0,
    });
    assert.deepEqual(inventory.integrity, {
      messagesWithoutAccount: 0,
      messagesWithoutRawKey: 0,
      unsupportedDirections: 0,
      orphanAttachments: 0,
      missingAttachmentBlobs: 0,
      orphanMessageLabels: 0,
      missingMessageLabelDefinitions: 0,
      invalidRuleJson: 0,
      invalidUserPreferences: 0,
    });
    assert.equal(inventory.accounts[0].counts.attachments, 1);
    assert.equal(inventory.accounts[1].counts.outbound, 1);
    const template = createLegacyMappingTemplate(inventory);
    assert.equal(template.mappings.length, 2);
    assert.match(template.mappings[0].mailboxId, /^[0-9a-f-]{36}$/u);

    const mappingPath = join(root, 'mapping.json');
    await writeFile(mappingPath, `${JSON.stringify(template)}\n`);
    const mapping = await loadAndValidateLegacyMapping(mappingPath, inventory);
    assert.equal(mapping.mappings.length, 2);

    const provisioning = createLegacyProvisioningDraft({
      database,
      mapping,
      mappingSha256: legacyMappingSha256(mapping),
      owner: {
        userId: '019c6f3c-6260-7000-8000-000000000001',
        email: 'owner@example.com',
        displayName: 'Migration owner',
        issuer: 'https://team.cloudflareaccess.com',
        subject: 'owner-subject',
        systemAdmin: true,
      },
      now: 3456,
    });
    assert.equal(provisioning.manifest.users.length, 1);
    assert.equal(provisioning.manifest.mailboxes.length, 2);
    assert.equal(
      provisioning.manifest.users[0].defaultMailboxId,
      mapping.mappings[0].mailboxId,
    );
    assert.deepEqual(provisioning.manifest.mailboxes[0].aliases, ['info@example.com']);
    assert.deepEqual(provisioning.review.generated, { mailboxes: 2, aliases: 1 });
    assert.deepEqual(provisioning.review.defaultFrom, {
      configured: true,
      sourceAddress: 'first@example.com',
      mailboxId: mapping.mappings[0].mailboxId,
    });
    assert.equal(provisioning.review.createdAt, 3456);
    assert.equal(provisioning.review.sourceDatabaseSha256, inventory.source.databaseSha256);
    assert.equal(provisioning.review.mappingSha256, legacyMappingSha256(mapping));
    assert.equal(provisioning.review.externalAliases[0].source, 'forward@example.com');
    assert.match(provisioning.review.externalAliases[0].reason, /forward/u);
    assert.equal(provisioning.review.domains[0].domain, 'example.com');
    assert.deepEqual(provisioning.review.membershipSuggestions[0], {
      sourceAddress: 'first@example.com',
      mailboxId: mapping.mappings[0].mailboxId,
      accessEmail: 'operator@example.com',
      legacyRole: 'user',
      canSend: true,
      active: true,
      suggestedRole: 'operator',
    });

    const provisionPath = join(root, 'provision.json');
    const reviewPath = join(root, 'provision-review.json');
    const output = [];
    assert.equal(await runLegacyMigrationCli([
      'provision-template', '--database', database, '--mapping', mappingPath,
      '--owner-user-id', '019c6f3c-6260-7000-8000-000000000001',
      '--owner-email', 'owner@example.com',
      '--access-issuer', 'https://team.cloudflareaccess.com',
      '--access-subject', 'owner-subject', '--system-admin',
      '--output', provisionPath, '--report', reviewPath,
    ], { stdout: (value) => output.push(value) }), 0);
    const writtenManifest = JSON.parse(await readFile(provisionPath, 'utf8'));
    const writtenReview = JSON.parse(await readFile(reviewPath, 'utf8'));
    assert.equal(writtenManifest.users[0].systemAdmin, true);
    assert.equal(writtenReview.generated.mailboxes, 2);
    assert.match(output.join(''), /"externalAliases": 1/u);

    const deploymentPath = join(root, 'deployment-with-external-alias.json');
    await writeFile(deploymentPath, `${JSON.stringify(deploymentManifest())}\n`);
    await assert.rejects(
      runLegacyMigrationCli([
        'verify-provisioning', '--database', database, '--mapping', mappingPath,
        '--manifest', provisionPath, '--review', reviewPath,
        '--deployment', deploymentPath,
        '--output', join(root, 'blocked-verification.json'),
      ], { stdout: () => {} }),
      /external aliases/u,
    );
  });

  it('binds the mapped directory, Access issuer, and mail domains to deployment', async () => {
    const sql = join(root, 'verification-safe.sql');
    const database = join(root, 'verification.sqlite');
    await writeFile(sql, fixtureSql({ externalAlias: false }));
    await importLegacySafeSql({ sql, database, now: 4000 });
    const inventory = createLegacyInventory(database, 4100);
    const mapping = createLegacyMappingTemplate(inventory);
    const mappingPath = join(root, 'verification-mapping.json');
    await writeFile(mappingPath, `${JSON.stringify(mapping)}\n`);
    const provisioning = createLegacyProvisioningDraft({
      database,
      mapping,
      mappingSha256: legacyMappingSha256(mapping),
      owner: {
        userId: '019c6f3c-6260-7000-8000-000000000001',
        email: 'owner@example.com',
        issuer: 'https://team.cloudflareaccess.com',
        subject: 'owner-subject',
        systemAdmin: true,
      },
      now: 4200,
    });
    const operatorId = '019c6f3c-6260-7000-8000-000000000002';
    provisioning.manifest.users.push({
      id: operatorId,
      email: 'operator@example.com',
      systemAdmin: false,
      identities: [{
        issuer: 'https://team.cloudflareaccess.com',
        subject: 'operator-subject',
        email: 'operator@example.com',
      }],
    });
    provisioning.manifest.mailboxes[0].members.push({
      userId: operatorId,
      role: 'operator',
    });
    const manifestPath = join(root, 'verified-provision.json');
    const reviewPath = join(root, 'verified-review.json');
    const deploymentPath = join(root, 'verified-deployment.json');
    const outputPath = join(root, 'provision-verification.json');
    await Promise.all([
      writeFile(manifestPath, `${JSON.stringify(provisioning.manifest)}\n`),
      writeFile(reviewPath, `${JSON.stringify(provisioning.review)}\n`),
      writeFile(deploymentPath, `${JSON.stringify(deploymentManifest())}\n`),
    ]);
    assert.equal(await runLegacyMigrationCli([
      'verify-provisioning', '--database', database, '--mapping', mappingPath,
      '--manifest', manifestPath, '--review', reviewPath,
      '--deployment', deploymentPath, '--output', outputPath,
    ], { stdout: () => {} }), 0);
    const verification = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(verification.ready, true);
    assert.deepEqual(verification.counts, {
      users: 2,
      mailboxes: 2,
      aliases: 1,
      defaultMailboxPreferences: 1,
      resolvedMemberships: 1,
      ignoredInactiveMemberships: 0,
      routingDomains: 1,
      sendingDomains: 1,
    });
    assert.match(verification.artifacts.manifestSha256, /^[0-9a-f]{64}$/u);
  });

  it('rejects non-backup SQL without leaving a database behind', async () => {
    const sql = join(root, 'unsafe.sql');
    const database = join(root, 'unsafe.sqlite');
    await writeFile(sql, `${fixtureSql()}\nDROP TABLE messages;\n`);
    await assert.rejects(
      importLegacySafeSql({ sql, database }),
      /outside the safe-backup format/u,
    );
    await assert.rejects(readFile(database), /ENOENT/u);
  });

  it('requires every message account to be mapped or explicitly excluded', async () => {
    const inventory = createLegacyInventory(join(root, 'legacy.sqlite'));
    const template = createLegacyMappingTemplate(inventory);
    template.mappings.pop();
    const mappingPath = join(root, 'incomplete-mapping.json');
    await writeFile(mappingPath, `${JSON.stringify(template)}\n`);
    await assert.rejects(
      loadAndValidateLegacyMapping(mappingPath, inventory),
      /unassigned/u,
    );
  });
});

function fixtureSql(options = {}) {
  const externalAlias = options.externalAlias === false ? '' : `
INSERT INTO "mail_aliases" ("id", "source", "destination", "is_active", "alias_kind", "notes", "created_at") VALUES (2, 'forward@example.com', 'outside@example.net', 1, 'forward', 'external forwarding', 902);`;
  return `-- CF Webmail Starter safe logical backup
-- fixture with a semicolon and newline inside a SQL string
PRAGMA foreign_keys=OFF;
-- table: mail_accounts
DELETE FROM "mail_accounts";
INSERT INTO "mail_accounts" ("id", "email", "display_name", "is_active") VALUES (1, 'first@example.com', 'First;\nMailbox', 1);
INSERT INTO "mail_accounts" ("id", "email", "display_name", "is_active") VALUES (2, 'second@example.com', 'Second', 1);
-- table: mail_domains
DELETE FROM "mail_domains";
INSERT INTO "mail_domains" ("id", "domain", "display_name", "webmail_url", "is_active", "created_at", "routing_status", "dns_status", "inbound_policy", "notes") VALUES (1, 'example.com', 'Example', 'https://mail.example.com', 1, 900, 'ready', 'ready', 'reject', 'review DNS');
-- table: mail_aliases
DELETE FROM "mail_aliases";
INSERT INTO "mail_aliases" ("id", "source", "destination", "is_active", "alias_kind", "notes", "created_at") VALUES (1, 'info@example.com', 'first@example.com', 1, 'alias', 'local alias', 901);
${externalAlias}
-- table: mail_account_users
DELETE FROM "mail_account_users";
INSERT INTO "mail_account_users" ("id", "account_email", "access_email", "role", "can_send", "is_active", "created_at") VALUES (1, 'first@example.com', 'operator@example.com', 'user', 1, 1, 903);
-- table: app_settings
DELETE FROM "app_settings";
INSERT INTO "app_settings" ("key", "value", "updated_at") VALUES ('default_from', 'first@example.com', 904);
-- table: messages
DELETE FROM "messages";
INSERT INTO "messages" ("id", "direction", "message_id", "raw_sha256", "subject", "sender", "recipients", "cc", "date_header", "received_at", "text_preview", "raw_key", "body_text_key", "body_html_key", "size", "has_attachments", "archived", "compressed", "created_at", "is_read", "starred", "deleted", "deleted_at", "account_email", "bcc", "in_reply_to", "references_header", "source_message_id", "compose_mode", "send_status", "provider") VALUES ('old-1', 'in', '<one@example.net>', '${'a'.repeat(64)}', 'One', 'sender@example.net', 'first@example.com', '', 'date', 1000, 'body', 'raw/one.eml.gz', 'body/one.txt.gz', 'body/one.html.gz', 100, 1, 1, 1, 1001, 1, 1, 0, NULL, 'first@example.com', '', '', '', '', '', '', '');
INSERT INTO "messages" ("id", "direction", "message_id", "raw_sha256", "subject", "sender", "recipients", "cc", "date_header", "received_at", "text_preview", "raw_key", "body_text_key", "body_html_key", "size", "has_attachments", "archived", "compressed", "created_at", "is_read", "starred", "deleted", "deleted_at", "account_email", "bcc", "in_reply_to", "references_header", "source_message_id", "compose_mode", "send_status", "provider") VALUES ('old-2', 'sent', '<two@example.net>', '${'b'.repeat(64)}', 'Two', 'second@example.com', 'recipient@example.net', '', 'date', 2000, 'body', 'raw/two.eml.gz', 'body/two.txt.gz', NULL, 200, 0, 0, 1, 2001, 1, 0, 1, 2002, 'second@example.com', 'blind@example.net', '<one@example.net>', '<one@example.net>', 'old-1', 'reply', 'sent', 'smtp2go');
-- table: blobs
DELETE FROM "blobs";
INSERT INTO "blobs" ("sha256", "size", "content_type", "storage_key", "filename_hint", "ref_count", "created_at") VALUES ('${'c'.repeat(64)}', 5, 'text/plain', 'attach/cc', 'one.txt', 1, 1001);
-- table: attachments
DELETE FROM "attachments";
INSERT INTO "attachments" ("id", "message_id", "blob_sha256", "filename", "content_type", "size") VALUES (1, 'old-1', '${'c'.repeat(64)}', 'one.txt', 'text/plain', 5);
PRAGMA foreign_keys=ON;
`;
}

function deploymentManifest() {
  return {
    version: 1,
    environment: 'production',
    mode: 'initial',
    accountId: 'a'.repeat(32),
    hostname: 'mail.example.com',
    workers: { web: 'cf-webmail-web', ingest: 'cf-webmail-ingest', jobs: 'cf-webmail-jobs' },
    access: {
      teamDomain: 'https://team.cloudflareaccess.com',
      audience: 'b'.repeat(64),
    },
    resources: {
      d1: { name: 'cf-webmail', id: '019c6f3c-6260-7000-8000-000000000003' },
      r2: { bucket: 'cf-webmail-raw' },
      queues: {
        inbound: 'cf-webmail-v2-inbound',
        inboundDlq: 'cf-webmail-v2-inbound-dlq',
        outbound: 'cf-webmail-v2-outbound',
        outboundDlq: 'cf-webmail-v2-outbound-dlq',
      },
    },
    email: { sendingDomains: ['example.com'], routingDomains: ['example.com'] },
    limits: { queueMaxConcurrency: 1 },
  };
}
