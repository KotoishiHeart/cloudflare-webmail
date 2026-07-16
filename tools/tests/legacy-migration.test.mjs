import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLegacyInventory, createLegacyMappingTemplate, loadAndValidateLegacyMapping } from '../lib/legacy-inventory.mjs';
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
    });
    assert.deepEqual(inventory.integrity, {
      messagesWithoutAccount: 0,
      messagesWithoutRawKey: 0,
      unsupportedDirections: 0,
      orphanAttachments: 0,
      missingAttachmentBlobs: 0,
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

function fixtureSql() {
  return `-- CF Webmail Starter safe logical backup
-- fixture with a semicolon and newline inside a SQL string
PRAGMA foreign_keys=OFF;
-- table: mail_accounts
DELETE FROM "mail_accounts";
INSERT INTO "mail_accounts" ("id", "email", "display_name", "is_active") VALUES (1, 'first@example.com', 'First;\nMailbox', 1);
INSERT INTO "mail_accounts" ("id", "email", "display_name", "is_active") VALUES (2, 'second@example.com', 'Second', 1);
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
