import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

test('label constraint repair preserves existing labels and relationships', async () => {
  const migrationNames = (await readdir('migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const repairName = '0013_repair_mailbox_label_color_check.sql';
  assert.equal(migrationNames.at(-1), repairName);

  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    for (const name of migrationNames.slice(0, -1)) {
      database.exec(await readFile(`migrations/${name}`, 'utf8'));
    }
    seedRelatedLabelData(database);

    database.exec(await readFile(`migrations/${repairName}`, 'utf8'));

    assert.deepEqual(asPlainRows(database.prepare(`
      SELECT id, color FROM mailbox_labels ORDER BY id
    `).all()), [{ id: 'label-1', color: '#1a2B3c' }]);
    assert.deepEqual(asPlainRows(database.prepare(`
      SELECT message_id, label_id FROM message_labels
    `).all()), [{ message_id: 'message-1', label_id: 'label-1' }]);
    assert.deepEqual(asPlainRows(database.prepare(`
      SELECT rule_id, label_id FROM mail_rule_labels
    `).all()), [{ rule_id: 'rule-1', label_id: 'label-1' }]);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

    insertLabel(database, 'label-lower', '#abcdef');
    insertLabel(database, 'label-upper', '#ABCDEF');
    assert.throws(() => insertLabel(database, 'label-invalid', '#abcdeg'));
  } finally {
    database.close();
  }
});

function seedRelatedLabelData(database) {
  database.exec(`
    INSERT INTO users (id, email, created_at, updated_at)
    VALUES ('user-1', 'owner@example.com', 1, 1);

    INSERT INTO mailboxes (id, display_name, created_at, updated_at)
    VALUES ('mailbox-1', 'Primary', 1, 1);

    INSERT INTO messages (
      id, mailbox_id, direction, status, delivered_to, received_at,
      raw_key, raw_sha256, raw_etag, raw_size, created_at, updated_at
    ) VALUES (
      'message-1', 'mailbox-1', 'inbound', 'ready', 'owner@example.com', 1,
      'raw/message-1', '${'a'.repeat(64)}', 'etag-1', 1, 1, 1
    );

    INSERT INTO mailbox_labels (
      id, mailbox_id, name, color, created_by_user_id, created_at, updated_at
    ) VALUES (
      'label-1', 'mailbox-1', 'Important', '#1a2B3c', 'user-1', 1, 1
    );

    INSERT INTO mail_rules (
      id, mailbox_id, name, conditions_json, actions_json,
      created_by_user_id, created_at, updated_at
    ) VALUES (
      'rule-1', 'mailbox-1', 'Important senders', '{}', '{}',
      'user-1', 1, 1
    );

    INSERT INTO message_labels (
      message_id, mailbox_id, label_id, source_rule_id,
      applied_by_user_id, created_at
    ) VALUES (
      'message-1', 'mailbox-1', 'label-1', 'rule-1', 'user-1', 1
    );

    INSERT INTO mail_rule_labels (rule_id, mailbox_id, label_id)
    VALUES ('rule-1', 'mailbox-1', 'label-1');
  `);
}

function insertLabel(database, id, color) {
  database.prepare(`
    INSERT INTO mailbox_labels (
      id, mailbox_id, name, color, created_by_user_id, created_at, updated_at
    ) VALUES (?, 'mailbox-1', ?, ?, 'user-1', 2, 2)
  `).run(id, id, color);
}

function asPlainRows(rows) {
  return rows.map((row) => ({ ...row }));
}
