import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { validateProvisionManifest } from '../lib/ops-manifest.mjs';
import { runOpsCli } from '../lib/ops-cli.mjs';
import {
  renderProvisionSql,
  renderRetryDeadLetterSql,
  renderRetryOutboundSql,
} from '../lib/ops-sql.mjs';

const USER_ID = '019c315c-1f20-7000-8000-000000000601';
const MAILBOX_ID = '019c315c-1f20-7000-8000-000000000602';

describe('operations manifest', () => {
  it('normalizes a valid manifest and renders repeatable conflict-safe SQL', async () => {
    const manifest = validateProvisionManifest({
      version: 1,
      users: [{
        id: USER_ID,
        email: 'Owner@Example.COM',
        displayName: "O'Brien",
        systemAdmin: true,
        defaultMailboxId: MAILBOX_ID,
        identities: [{
          issuer: 'https://team.cloudflareaccess.com/',
          subject: 'subject-1',
        }],
      }],
      mailboxes: [{
        id: MAILBOX_ID,
        address: 'MAIL@example.com',
        ownerUserId: USER_ID,
        aliases: ['alias@example.com'],
        members: [],
      }],
    });
    assert.equal(manifest.users[0].email, 'owner@example.com');
    assert.equal(manifest.users[0].identities[0].issuer, 'https://team.cloudflareaccess.com');
    const sql = renderProvisionSql(manifest, 1234);
    assert.match(sql, /O''Brien/u);
    assert.match(sql, /ON CONFLICT\(issuer, subject\)/u);
    assert.match(sql, /'primary'/u);
    assert.match(sql, /CF_WEBMAIL_OWNERSHIP_CONFLICT/u);
    assert.match(sql, /INSERT INTO system_administrators/u);
    assert.match(sql, /INSERT INTO user_preferences/u);
    assert.match(sql, new RegExp(`default_mailbox_id[\\s\\S]+${MAILBOX_ID}`, 'u'));
    assert.doesNotMatch(sql, /BEGIN TRANSACTION/u);
    const clearSql = renderProvisionSql({
      ...manifest,
      users: manifest.users.map((user) => ({ ...user, defaultMailboxId: null })),
    }, 1234);
    assert.match(clearSql, /'inbox', NULL,/u);
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('PRAGMA foreign_keys = ON;');
      for (const name of (await readdir('migrations')).filter((item) => item.endsWith('.sql')).sort()) {
        database.exec(await readFile(`migrations/${name}`, 'utf8'));
      }
      database.exec(sql);
      assert.deepEqual({ ...database.prepare(`
        SELECT user_id, default_mailbox_id FROM user_preferences
      `).get() }, { user_id: USER_ID, default_mailbox_id: MAILBOX_ID });
    } finally {
      database.close();
    }
  });

  it('rejects duplicate addresses and dangling owners', () => {
    assert.throws(() => validateProvisionManifest({
      version: 1,
      users: [],
      mailboxes: [{
        id: MAILBOX_ID,
        address: 'mail@example.com',
        ownerUserId: USER_ID,
      }],
    }), /does not reference/u);
    assert.throws(() => validateProvisionManifest({
      version: 1,
      users: [{
        id: USER_ID,
        email: 'owner@example.com',
        defaultMailboxId: '019c315c-1f20-7000-8000-000000000699',
        identities: [{ issuer: 'https://team.cloudflareaccess.com', subject: 'subject' }],
      }],
      mailboxes: [{
        id: MAILBOX_ID,
        address: 'mail@example.com',
        ownerUserId: USER_ID,
      }],
    }), /defaultMailboxId does not reference/u);
  });
});

describe('operations mutations', () => {
  it('requires explicit target and confirmation before applying a plan', async () => {
    await assert.rejects(
      runOpsCli(['apply', '--plan', 'plan.sql', '--local'], fakeIo()),
      /pass --yes/u,
    );
    await assert.rejects(
      runOpsCli(['apply', '--plan', 'plan.sql', '--yes'], fakeIo()),
      /exactly one/u,
    );
  });

  it('passes structured arguments to Wrangler without a shell', async () => {
    const calls = [];
    const status = await runOpsCli([
      'retry-outbound', '--message-id', MAILBOX_ID, '--local', '--yes',
    ], fakeIo(calls));
    assert.equal(status, 0);
    assert.equal(calls[0].command, 'npx');
    assert.equal(calls[0].options.shell, false);
    assert.deepEqual(
      calls[0].args.slice(0, 5),
      ['--no-install', 'wrangler', 'd1', 'execute', 'cf-webmail'],
    );
    assert.match(calls[0].args[calls[0].args.indexOf('--command') + 1], /attempt_count = 0/u);
  });

  it('lists storage issues through a read-only D1 query', async () => {
    const calls = [];
    const status = await runOpsCli(['storage-issues', '--local'], fakeIo(calls));
    assert.equal(status, 0);
    const sql = calls[0].args[calls[0].args.indexOf('--command') + 1];
    assert.match(sql, /FROM storage_issues/u);
    assert.match(sql, /status = 'open'/u);
  });

  it('renders only a failed-message retry guarded by message ID', () => {
    const sql = renderRetryOutboundSql(MAILBOX_ID, 1234);
    assert.match(sql, /status = 'failed'/u);
    assert.match(sql, new RegExp(MAILBOX_ID, 'u'));
    assert.throws(() => renderRetryOutboundSql('not-an-id'), /UUID/u);
  });

  it('requests a validated dead-letter retry without sending from the CLI', async () => {
    const id = 'a'.repeat(64);
    const sql = renderRetryDeadLetterSql(id, 1234);
    assert.match(sql, /status = 'retry_requested'/u);
    assert.match(sql, /payload_valid = 1/u);
    assert.throws(() => renderRetryDeadLetterSql('not-a-digest'), /SHA-256/u);

    const calls = [];
    await runOpsCli([
      'retry-dead-letter', '--dead-letter-id', id, '--remote', '--yes',
    ], fakeIo(calls));
    assert.match(calls[0].args[calls[0].args.indexOf('--command') + 1], /retry_requested/u);
  });
});

function fakeIo(calls = []) {
  return {
    stdout: () => undefined,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  };
}
