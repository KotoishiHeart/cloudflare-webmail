import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLegacyStageBulk } from '../lib/legacy-bulk-apply.mjs';
import { materializeLegacyR2Tree } from '../lib/legacy-bulk-stage.mjs';

const MAILBOX_ID = '019c315c-1f20-7000-8000-000000000701';
const BATCH_ID = '019c315c-1f20-7000-8000-000000000702';
const HASH = 'a'.repeat(64);
let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cf-webmail-legacy-bulk-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('legacy bulk apply', () => {
  it('materializes target keys and verifies R2 before applying and auditing D1', async () => {
    const stage = await createStage(join(root, 'stage'));
    const treePath = join(root, 'tree');
    const materialized = await materializeLegacyR2Tree(stage, treePath);
    assert.equal(materialized.objects, 1);
    assert.equal((await readFile(join(treePath, objectKey()), 'utf8')), 'raw message');

    const calls = [];
    const runner = { spawn(command, args) {
      calls.push({ command, args });
      if (command === 'rclone' && args[0] === 'check') {
        writeFileSync(args[args.indexOf('--combined') + 1], `= ${objectKey()}\n`);
      }
      if (command === 'npx' && args.includes('--command')) {
        const sql = args[args.indexOf('--command') + 1];
        const results = sql.includes('FROM migration_batches') ? [batchRow()] : [accountRow()];
        return { status: 0, stdout: JSON.stringify([{ results }]), stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    } };
    const options = {
      yes: true,
      local: true,
      remote: false,
      database: 'cf-webmail',
      config: 'apps/web/wrangler.jsonc',
      tree: treePath,
      rcloneDestination: 'test-r2:cf-webmail-raw',
      transfers: 4,
      checkers: 8,
    };
    const state = await applyLegacyStageBulk(stage, options, runner);
    assert.equal(state.r2Copied, true);
    assert.equal(state.r2Verified, true);
    assert.equal(state.nextSql, 1);
    assert.deepEqual(state.d1Audit, { batchId: BATCH_ID, messages: 1, objects: 1 });
    assert.match(state.r2Report.sha256, /^[0-9a-f]{64}$/u);
    const checkIndex = calls.findIndex((call) => call.command === 'rclone' && call.args[0] === 'check');
    const d1FileIndex = calls.findIndex((call) => call.command === 'npx' && call.args.includes('--file'));
    assert.ok(checkIndex >= 0 && d1FileIndex > checkIndex);

    const callCount = calls.length;
    const resumed = await applyLegacyStageBulk(stage, options, runner);
    assert.equal(resumed.completedAt, state.completedAt);
    assert.equal(calls.length, callCount);
  });
});

async function createStage(stage) {
  await mkdir(join(stage, 'objects'), { recursive: true });
  await mkdir(join(stage, 'd1'), { recursive: true });
  const object = Buffer.from('raw message');
  const sql = Buffer.from('SELECT 1;\n');
  await writeFile(join(stage, 'objects/00000000.bin'), object);
  await writeFile(join(stage, 'd1/000000.sql'), sql);
  const manifest = {
    version: 2,
    kind: 'cf-webmail-migration-stage',
    sourceFormat: 'cloudflare-webmail-archived-d1-r2',
    createdAt: 1,
    batchId: BATCH_ID,
    sourceDatabaseSha256: HASH,
    mappingSha256: HASH,
    snapshotSha256: HASH,
    complete: true,
    mappings: [{
      sourceAddress: 'mail@example.com',
      mailboxId: MAILBOX_ID,
      address: 'mail@example.com',
      discovered: 1,
      prepared: 1,
      failed: 0,
      inbound: 1,
      outbound: 0,
      read: 1,
      starred: 0,
      archived: 0,
      deleted: 0,
      attachments: 0,
    }],
    exclusions: [],
    counts: {
      discovered: 1,
      prepared: 1,
      duplicates: 0,
      failed: 0,
      quarantined: 0,
      sourceObjects: 1,
      objects: 1,
    },
    sqlFiles: [{ file: 'd1/000000.sql', size: sql.byteLength, sha256: hash(sql) }],
  };
  await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(stage, 'objects.jsonl'), `${JSON.stringify({
    key: objectKey(),
    file: 'objects/00000000.bin',
    contentType: 'message/rfc822',
    size: object.byteLength,
    sha256: hash(object),
  })}\n`);
  await writeFile(join(stage, 'failures.jsonl'), '');
  return stage;
}

function batchRow() {
  return {
    source_database_sha256: HASH,
    mapping_sha256: HASH,
    snapshot_sha256: HASH,
    expected_messages: 1,
    source_objects: 1,
    staged_objects: 1,
    imported_messages: 1,
    object_references: 1,
    quarantined: 0,
  };
}

function accountRow() {
  return {
    source_account: 'mail@example.com',
    prepared: 1,
    inbound: 1,
    outbound: 0,
    read_count: 1,
    starred: 0,
    archived: 0,
    deleted: 0,
    attachments: 0,
  };
}

function objectKey() {
  return `mailboxes/${MAILBOX_ID}/messages/${BATCH_ID}/raw.eml`;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
