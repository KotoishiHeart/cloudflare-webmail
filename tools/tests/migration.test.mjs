import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import {
  applyMigrationStage,
  prepareMigrationStage,
  verifyMigrationStage,
} from '../lib/migration-stage.mjs';
import { discoverMessageFiles, readMessageFile } from '../lib/migration-source.mjs';

const MAILBOX_ID = '019c315c-1f20-7000-8000-000000000701';
let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cf-webmail-migration-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('migration stage', () => {
  it('prepares and verifies a deduplicated Maildir stage', async () => {
    const maildir = join(root, 'Maildir');
    await mkdir(join(maildir, 'cur'), { recursive: true });
    await mkdir(join(maildir, 'new'), { recursive: true });
    const raw = sampleEmail();
    await writeFile(join(maildir, 'cur', 'one:2,SF'), raw);
    await writeFile(join(maildir, 'new', 'duplicate'), raw);
    const stage = join(root, 'stage-maildir');
    const manifest = await prepareMigrationStage({
      source: maildir,
      format: 'maildir',
      stage,
      mailboxId: MAILBOX_ID,
      address: 'mailbox@example.com',
      direction: 'inbound',
      now: 1234,
    });
    assert.deepEqual(manifest.counts, {
      discovered: 2,
      prepared: 1,
      duplicates: 1,
      failed: 0,
      objects: 3,
    });
    const verified = await verifyMigrationStage(stage);
    assert.equal(verified.objects.length, 3);
    const sql = await readFile(join(stage, manifest.sqlFiles[0].file), 'utf8');
    assert.match(sql, /'inbound', 'ready'/u);
    assert.match(sql, /, 1, 1, 0, 0, 1234, 1234/u);
    assert.match(sql, /hello\.txt/u);
    await writeFile(join(stage, manifest.sqlFiles[0].file), `${sql}\n-- tampered`);
    await assert.rejects(verifyMigrationStage(stage), /SQL verification failed/u);
  });

  it('reads gzipped legacy EML trees and rejects tampered stage objects', async () => {
    const source = join(root, 'legacy-objects');
    await mkdir(join(source, 'raw', '2026'), { recursive: true });
    await writeFile(join(source, 'raw', '2026', 'message.eml.gz'), gzipSync(sampleEmail()));
    const files = await discoverMessageFiles(source, 'eml-tree');
    assert.equal(files.length, 1);
    const loaded = await readMessageFile(files[0]);
    assert.match(loaded.raw.toString(), /Migration fixture/u);

    const stage = join(root, 'stage-legacy');
    await prepareMigrationStage({
      source,
      format: 'eml-tree',
      stage,
      mailboxId: MAILBOX_ID,
      address: 'mailbox@example.com',
      direction: 'outbound',
      now: 1234,
    });
    const verified = await verifyMigrationStage(stage);
    await writeFile(join(stage, verified.objects[0].file), 'tampered');
    await assert.rejects(verifyMigrationStage(stage), /verification failed/u);
  });

  it('uploads every R2 object before D1 and resumes from apply state', async () => {
    const source = join(root, 'apply-source');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'message.eml'), sampleEmail());
    const stage = join(root, 'stage-apply');
    await prepareMigrationStage({
      source,
      format: 'eml-tree',
      stage,
      mailboxId: MAILBOX_ID,
      address: 'mailbox@example.com',
      direction: 'inbound',
      now: 1234,
    });
    const calls = [];
    const io = { spawn: (_command, args) => { calls.push(args); return { status: 0 }; } };
    const options = {
      local: true,
      remote: false,
      bucket: 'cf-webmail-raw',
      database: 'cf-webmail',
      config: 'apps/web/wrangler.jsonc',
    };
    const state = await applyMigrationStage(stage, options, io);
    const d1Index = calls.findIndex((args) => args.includes('d1'));
    assert.ok(d1Index > 0);
    assert.ok(calls.slice(0, d1Index).every((args) => args.includes('r2')));
    assert.equal(state.nextSql, 1);
    const resumedCalls = [];
    await applyMigrationStage(stage, options, {
      spawn: (_command, args) => { resumedCalls.push(args); return { status: 0 }; },
    });
    assert.deepEqual(resumedCalls, []);
  });
});

function sampleEmail() {
  return [
    'From: Sender <sender@example.net>',
    'To: mailbox@example.com',
    'Subject: Migration fixture',
    'Message-ID: <migration-fixture@example.net>',
    'Date: Thu, 16 Jul 2026 12:00:00 GMT',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="fixture"',
    '',
    '--fixture',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'migrated body',
    '--fixture',
    'Content-Type: text/plain; name="hello.txt"',
    'Content-Disposition: attachment; filename="hello.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    'aGVsbG8=',
    '--fixture--',
    '',
  ].join('\r\n');
}
