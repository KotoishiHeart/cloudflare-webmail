import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { createLegacyInventory, createLegacyMappingTemplate } from '../lib/legacy-inventory.mjs';
import { fetchLegacySnapshot, verifyLegacySnapshot } from '../lib/legacy-snapshot.mjs';
import { fetchLegacySnapshotBulk } from '../lib/legacy-snapshot-bulk.mjs';
import { importLegacySafeSql } from '../lib/legacy-sqlite.mjs';

let root;
let database;
let mapping;
let objectRoot;
const rawOne = rawEmail('One', '<one@example.net>');
const rawTwo = rawEmail('Two', '<two@example.net>');

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cf-webmail-legacy-snapshot-test-'));
  database = join(root, 'legacy.sqlite');
  const sql = join(root, 'safe.sql');
  await writeFile(sql, safeSql([
    legacyMessage('old-1', 'first@example.com', 'raw/one.eml.gz', rawOne),
    legacyMessage('old-2', 'second@example.com', 'raw/two.eml.gz', rawTwo),
  ]));
  await importLegacySafeSql({ sql, database, now: 1234 });
  mapping = createLegacyMappingTemplate(createLegacyInventory(database));
  objectRoot = join(root, 'old-r2');
  await mkdir(join(objectRoot, 'raw'), { recursive: true });
  await writeFile(join(objectRoot, 'raw', 'one.eml.gz'), gzipSync(rawOne));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('archived raw R2 snapshot', () => {
  it('records missing objects and resumes after the source is repaired', async () => {
    const snapshot = join(root, 'snapshot-resume');
    const first = await fetchLegacySnapshot({
      database, mapping, snapshot, objectRoot, concurrency: 2, now: 2345,
    });
    assert.deepEqual(first.counts, { pending: 0, ready: 1, missing: 1, invalid: 0 });
    assert.equal(first.complete, false);

    await writeFile(join(objectRoot, 'raw', 'two.eml.gz'), gzipSync(rawTwo));
    const resumed = await fetchLegacySnapshot({
      database, mapping, snapshot, objectRoot, concurrency: 2,
    });
    assert.deepEqual(resumed.counts, { pending: 0, ready: 2, missing: 0, invalid: 0 });
    assert.equal(resumed.messageReferences, 2);
    assert.equal(resumed.complete, true);
    const verified = await verifyLegacySnapshot({ database, mapping, snapshot });
    assert.equal(verified.objects, 2);
  });

  it('detects snapshot object tampering', async () => {
    const snapshot = join(root, 'snapshot-tamper');
    await fetchLegacySnapshot({ database, mapping, snapshot, objectRoot, concurrency: 1 });
    const state = new DatabaseSync(join(snapshot, 'snapshot.sqlite'), { readOnly: true });
    const row = state.prepare('SELECT file FROM snapshot_objects ORDER BY source_key LIMIT 1').get();
    state.close();
    await writeFile(join(snapshot, row.file), 'tampered');
    await assert.rejects(
      verifyLegacySnapshot({ database, mapping, snapshot }),
      /verification failed for 1 object/u,
    );
  });

  it('downloads the fixed raw-key set with one resumable rclone copy', async () => {
    const snapshot = join(root, 'snapshot-bulk');
    const remote = join(root, 'fake-rclone-remote');
    await mkdir(join(remote, 'raw'), { recursive: true });
    await Promise.all([
      writeFile(join(remote, 'raw', 'one.eml.gz'), gzipSync(rawOne)),
      writeFile(join(remote, 'raw', 'two.eml.gz'), gzipSync(rawTwo)),
    ]);
    const calls = [];
    const io = {
      async execFile(command, args) {
        calls.push({ command, args });
        if (args[0] === 'version') return { status: 0 };
        assert.deepEqual(args.slice(0, 2), ['copy', 'archive:old-bucket']);
        const destination = args[2];
        const list = args[args.indexOf('--files-from-raw') + 1];
        const keys = (await readFile(list, 'utf8')).trim().split('\n');
        for (const key of keys) {
          const target = join(destination, key);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, await readFile(join(remote, key)));
        }
        return { status: 0 };
      },
    };
    const result = await fetchLegacySnapshotBulk({
      database,
      mapping,
      snapshot,
      rcloneSource: 'archive:old-bucket',
      concurrency: 2,
      io,
      now: 3456,
    });
    assert.equal(result.complete, true);
    assert.equal(result.bulkSource.sourceObjects, 2);
    assert.equal(result.bulkSource.copied, 2);
    assert.match(result.bulkSource.sourceListSha256, /^[0-9a-f]{64}$/u);
    assert.equal((await stat(snapshot)).mode & 0o777, 0o700);
    assert.equal((await stat(join(snapshot, 'snapshot.sqlite'))).mode & 0o777, 0o600);
    assert.equal((await stat(result.bulkSource.sourceList)).mode & 0o777, 0o600);
    assert.equal(
      await readFile(result.bulkSource.sourceList, 'utf8'),
      'raw/one.eml.gz\nraw/two.eml.gz\n',
    );
    const state = new DatabaseSync(join(snapshot, 'snapshot.sqlite'), { readOnly: true });
    const storedFile = state.prepare('SELECT file FROM snapshot_objects LIMIT 1').get().file;
    state.close();
    assert.equal((await stat(join(snapshot, storedFile))).mode & 0o777, 0o600);
    await assert.rejects(readFile(join(snapshot, '.rclone-source', 'raw', 'one.eml.gz')), /ENOENT/u);
    const resumed = await fetchLegacySnapshotBulk({
      database, mapping, snapshot, rcloneSource: 'archive:old-bucket', io,
    });
    assert.equal(resumed.bulkSource.copied, 0);
    assert.equal(calls.filter((call) => call.args[0] === 'copy').length, 1);
    await assert.rejects(
      fetchLegacySnapshotBulk({
        database, mapping, snapshot, rcloneSource: 'other:old-bucket', io,
      }),
      /different R2 source/u,
    );
  });

  it('retains an interrupted rclone transfer and resumes only from the bound source', async () => {
    const snapshot = join(root, 'snapshot-interrupted-bulk');
    const remote = join(root, 'fake-interrupted-rclone-remote');
    await mkdir(join(remote, 'raw'), { recursive: true });
    await Promise.all([
      writeFile(join(remote, 'raw', 'one.eml.gz'), gzipSync(rawOne)),
      writeFile(join(remote, 'raw', 'two.eml.gz'), gzipSync(rawTwo)),
    ]);
    let copies = 0;
    const io = {
      async execFile(_command, args) {
        if (args[0] === 'version') return { status: 0 };
        copies += 1;
        const destination = args[2];
        const list = args[args.indexOf('--files-from-raw') + 1];
        const keys = (await readFile(list, 'utf8')).trim().split('\n');
        const selected = copies === 1 ? keys.slice(0, 1) : keys;
        for (const key of selected) {
          const target = join(destination, key);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, await readFile(join(remote, key)));
        }
        return copies === 1 ? { status: 1, stderr: 'interrupted' } : { status: 0 };
      },
    };
    await assert.rejects(
      fetchLegacySnapshotBulk({
        database, mapping, snapshot, rcloneSource: 'archive:old-bucket', io,
      }),
      /rclone exited with 1/u,
    );
    assert.equal(
      await readFile(join(snapshot, '.rclone-source', 'raw', 'one.eml.gz'))
        .then((value) => value.byteLength),
      gzipSync(rawOne).byteLength,
    );
    await assert.rejects(
      fetchLegacySnapshotBulk({
        database, mapping, snapshot, rcloneSource: 'other:old-bucket', io,
      }),
      /different R2 source/u,
    );
    const resumed = await fetchLegacySnapshotBulk({
      database, mapping, snapshot, rcloneSource: 'archive:old-bucket', io,
    });
    assert.equal(resumed.complete, true);
    assert.equal(copies, 2);
  });
});

function rawEmail(subject, messageId) {
  return Buffer.from([
    'From: sender@example.net',
    'To: mailbox@example.com',
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    'Date: Fri, 17 Jul 2026 00:00:00 GMT',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    `${subject} body`,
    '',
  ].join('\r\n'));
}

function legacyMessage(id, account, rawKey, raw) {
  return { id, account, rawKey, rawSha256: hash(raw), rawSize: raw.byteLength };
}

function safeSql(messages) {
  const accounts = [...new Set(messages.map((message) => message.account))];
  return `-- CF Webmail Starter safe logical backup
PRAGMA foreign_keys=OFF;
-- table: mail_accounts
DELETE FROM "mail_accounts";
${accounts.map((account, index) => `INSERT INTO "mail_accounts" ("id", "email", "display_name", "is_active") VALUES (${index + 1}, '${account}', '${account}', 1);`).join('\n')}
-- table: messages
DELETE FROM "messages";
${messages.map((message) => `INSERT INTO "messages" ("id", "direction", "raw_sha256", "received_at", "raw_key", "size", "compressed", "created_at", "account_email") VALUES ('${message.id}', 'in', '${message.rawSha256}', 1000, '${message.rawKey}', ${message.rawSize}, 1, 1000, '${message.account}');`).join('\n')}
-- table: blobs
DELETE FROM "blobs";
-- table: attachments
DELETE FROM "attachments";
PRAGMA foreign_keys=ON;
`;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
