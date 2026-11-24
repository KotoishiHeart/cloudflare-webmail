import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackup, restoreBackup, verifyBackup } from '../lib/backup-core.mjs';

const KEY = 'mailboxes/019c315c-1f20-7000-8000-000000000801/messages/019c315c-1f20-7000-8000-000000000802/raw.eml';
const OPTIONS = {
  local: true,
  remote: false,
  database: 'cf-webmail',
  bucket: 'cf-webmail-raw',
  config: 'apps/web/wrangler.jsonc',
};
let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cf-webmail-backup-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('portable D1 and R2 backup', () => {
  it('creates and verifies a hash-bound backup', async () => {
    const backup = join(root, 'backup');
    const calls = [];
    const manifest = await createBackup(backup, OPTIONS, fakeBackupRunner(calls));
    assert.equal(manifest.objects.length, 1);
    assert.equal(manifest.objects[0].key, KEY);
    assert.ok(calls.find((args) => args.includes('export')));
    assert.ok(calls.find((args) => args.includes('r2')));
    const verified = await verifyBackup(backup);
    assert.equal(verified.d1.sha256, manifest.d1.sha256);
    assert.match(await readFile(join(backup, 'd1.sql'), 'utf8'), new RegExp(KEY, 'u'));
  });

  it('downloads pending objects with one bulk rclone copy when a source is given', async () => {
    const backup = join(root, 'backup-bulk');
    const calls = [];
    const rcloneCalls = [];
    const runner = fakeBackupRunner(calls);
    runner.execFile = async (command, args) => {
      rcloneCalls.push([command, ...args]);
      if (args[0] === 'version') return { status: 0 };
      assert.equal(args[0], 'copy');
      const destination = args[2];
      const keys = (await readFile(args[args.indexOf('--files-from-raw') + 1], 'utf8'))
        .trim().split('\n');
      assert.deepEqual(keys, [KEY]);
      for (const key of keys) {
        const file = join(destination, key);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, 'raw backup fixture');
      }
      return { status: 0 };
    };
    const manifest = await createBackup(backup, {
      ...OPTIONS,
      local: false,
      remote: true,
      rcloneSource: 'test-r2:cf-webmail-raw',
    }, runner);
    assert.equal(manifest.objects.length, 1);
    assert.equal(manifest.objects[0].key, KEY);
    assert.ok(rcloneCalls.some((args) => args.includes('copy')));
    assert.equal(calls.find((args) => args.includes('get')), undefined);
    const verified = await verifyBackup(backup);
    assert.equal(verified.d1.sha256, manifest.d1.sha256);
    const names = await readdir(backup);
    assert.equal(names.some((name) => name.startsWith('.rclone-')), false);
  });

  it('rejects an rclone source for local backups or a different bucket', async () => {
    await assert.rejects(
      createBackup(join(root, 'backup-bulk-local'), {
        ...OPTIONS,
        rcloneSource: 'test-r2:cf-webmail-raw',
      }, fakeBackupRunner([])),
      /requires a remote backup/u,
    );
    await assert.rejects(
      createBackup(join(root, 'backup-bulk-bucket'), {
        ...OPTIONS,
        local: false,
        remote: true,
        rcloneSource: 'test-r2:another-bucket',
      }, fakeBackupRunner([])),
      /must match the backup bucket/u,
    );
  });

  it('restores objects before SQL, requires an empty D1, and resumes', async () => {
    const backup = join(root, 'backup');
    const calls = [];
    const runner = fakeRestoreRunner(calls, 0);
    const state = await restoreBackup(backup, { ...OPTIONS, emptyTarget: true }, runner);
    const putIndex = calls.findIndex((args) => args.includes('put'));
    const restoreIndex = calls.findIndex((args) => args.includes('d1') && args.includes('--file'));
    assert.ok(putIndex >= 0 && restoreIndex > putIndex);
    assert.equal(state.d1Restored, true);

    const resumed = [];
    await restoreBackup(backup, { ...OPTIONS, emptyTarget: true }, fakeRestoreRunner(resumed, 99));
    assert.equal(resumed.length, 0);

    const stateName = (await readdir(backup)).find((name) => name.startsWith('restore-state.'));
    const statePath = join(backup, stateName);
    const corrupted = JSON.parse(await readFile(statePath, 'utf8'));
    corrupted.nextObject = 2;
    await writeFile(statePath, JSON.stringify(corrupted));
    await assert.rejects(
      restoreBackup(backup, { ...OPTIONS, emptyTarget: true }, fakeRestoreRunner([], 0)),
      /restore state is invalid/u,
    );

    const secondBackup = join(root, 'backup-nonempty');
    await createBackup(secondBackup, OPTIONS, fakeBackupRunner([]));
    await assert.rejects(
      restoreBackup(
        secondBackup,
        { ...OPTIONS, emptyTarget: true },
        fakeRestoreRunner([], 2),
      ),
      /not empty/u,
    );
  });

  it('detects tampered R2 objects', async () => {
    const backup = join(root, 'backup');
    const manifest = await verifyBackup(backup);
    await writeFile(join(backup, manifest.objects[0].file), 'tampered');
    await assert.rejects(verifyBackup(backup), /verification failed/u);
  });
});

function fakeBackupRunner(calls) {
  return {
    spawn: (_command, args) => {
      calls.push(args);
      if (args.includes('export')) {
        const output = args[args.indexOf('--output') + 1];
        writeFileSync(output, `CREATE TABLE backup_test (object_key TEXT);\nINSERT INTO backup_test VALUES ('${KEY}');\n`);
        return { status: 0 };
      }
      if (args.includes('--json')) {
        return {
          status: 0,
          stdout: JSON.stringify([{
            results: [{ object_key: KEY, content_type: 'message/rfc822' }],
          }]),
          stderr: '',
        };
      }
      if (args.includes('get')) {
        const file = args[args.indexOf('--file') + 1];
        writeFileSync(file, 'raw backup fixture');
        return { status: 0 };
      }
      throw new Error(`unexpected backup command: ${args.join(' ')}`);
    },
  };
}

function fakeRestoreRunner(calls, tableCount) {
  return {
    spawn: (_command, args) => {
      if (args.includes('--json')) {
        return {
          status: 0,
          stdout: JSON.stringify([{ results: [{ table_count: tableCount }] }]),
          stderr: '',
        };
      }
      calls.push(args);
      return { status: 0 };
    },
  };
}
