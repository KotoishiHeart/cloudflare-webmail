import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { readLegacyImportMetadata } from './legacy-sqlite.mjs';
import {
  MAX_LEGACY_RAW_BYTES,
  legacySnapshotSha256,
  legacySnapshotSummary,
  resolveLegacySnapshotFile,
  validateLegacySnapshotIdentity,
} from './legacy-snapshot-state.mjs';

const gunzipAsync = promisify(gunzip);
const LEGACY_MESSAGE_SELECT = `
  SELECT id, direction, message_id, raw_sha256, subject, sender, recipients, cc,
    date_header, CAST(received_at AS INTEGER) AS received_at, text_preview,
    raw_key, body_text_key, body_html_key, CAST(size AS INTEGER) AS raw_size,
    CAST(has_attachments AS INTEGER) AS has_attachments,
    CAST(archived AS INTEGER) AS archived, CAST(compressed AS INTEGER) AS compressed,
    CAST(created_at AS INTEGER) AS created_at, CAST(is_read AS INTEGER) AS is_read,
    CAST(starred AS INTEGER) AS starred, CAST(deleted AS INTEGER) AS deleted,
    CAST(deleted_at AS INTEGER) AS deleted_at, LOWER(account_email) AS account_email,
    bcc, in_reply_to, references_header, source_message_id, compose_mode,
    send_status, provider
  FROM messages
`;

export function openLegacyStageSource(options) {
  const database = new DatabaseSync(resolve(options.database), { readOnly: true });
  const snapshotRoot = resolve(options.snapshot);
  const snapshot = new DatabaseSync(resolve(snapshotRoot, 'snapshot.sqlite'), { readOnly: true });
  try {
    validateLegacySnapshotIdentity(snapshot, options);
    const summary = legacySnapshotSummary(snapshot);
    if (!summary.complete) throw new Error('legacy raw snapshot is incomplete');
    const imported = readLegacyImportMetadata(database);
    const mappings = new Map(options.mapping.mappings.map((mapping) => [mapping.sourceAddress, mapping]));
    const messageStatement = database.prepare(
      `${LEGACY_MESSAGE_SELECT} ORDER BY LOWER(account_email), received_at, id`,
    );
    const snapshotStatement = snapshot.prepare(`
      SELECT source_key, file, compressed, expected_raw_sha256, expected_raw_size,
        stored_size, stored_sha256, status
      FROM snapshot_objects WHERE source_key = ?
    `);
    const attachmentStatement = database.prepare(`
      SELECT a.filename, a.content_type, CAST(a.size AS INTEGER) AS size, b.sha256
      FROM attachments AS a
      LEFT JOIN blobs AS b ON b.sha256 = a.blob_sha256
      WHERE a.message_id = ? ORDER BY CAST(a.id AS INTEGER), a.filename
    `);
    return {
      database,
      snapshot,
      snapshotRoot,
      mappings,
      messageStatement,
      snapshotStatement,
      attachmentStatement,
      imported,
      snapshotSummary: summary,
      snapshotSha256: legacySnapshotSha256(snapshot),
      close() {
        snapshot.close();
        database.close();
      },
    };
  } catch (error) {
    snapshot.close();
    database.close();
    throw error;
  }
}

export function legacyMessageByIdStatement(database) {
  return database.prepare(`${LEGACY_MESSAGE_SELECT} WHERE id = ?`);
}

export function normalizeLegacyMessage(row, mapping) {
  const receivedAt = positive(row.received_at, 'received_at');
  const createdAt = optionalPositive(row.created_at) ?? receivedAt;
  const direction = row.direction === 'in' ? 'in' : row.direction === 'sent' ? 'sent' : null;
  if (direction === null) throw new Error('legacy message direction is invalid');
  const dateHeader = text(row.date_header, 8192, 'date_header');
  return {
    id: text(row.id, 128, 'id', true),
    accountEmail: mapping.sourceAddress,
    targetMailboxId: mapping.mailboxId,
    targetAddress: mapping.address,
    direction,
    rawSha256: hash(row.raw_sha256, 'raw_sha256'),
    rawSize: integer(row.raw_size, 1, MAX_LEGACY_RAW_BYTES, 'raw_size'),
    rawKey: text(row.raw_key, 1024, 'raw_key', true),
    bodyTextKey: text(row.body_text_key, 1024, 'body_text_key'),
    bodyHtmlKey: text(row.body_html_key, 1024, 'body_html_key'),
    compressed: Number(row.compressed) === 1,
    receivedAt,
    createdAt,
    deletedAt: optionalPositive(row.deleted_at),
    flags: {
      isRead: Number(row.is_read) !== 0,
      isStarred: Number(row.starred) !== 0,
      isArchived: Number(row.archived) !== 0,
      isDeleted: Number(row.deleted) !== 0,
    },
    metadata: {
      receivedAt,
      rfcMessageId: text(row.message_id, 998, 'message_id'),
      inReplyTo: text(row.in_reply_to, 998, 'in_reply_to'),
      referencesHeader: text(row.references_header, 8192, 'references_header'),
      subject: text(row.subject, 998, 'subject'),
      sender: text(row.sender, 2048, 'sender'),
      recipients: text(row.recipients, 8192, 'recipients'),
      cc: text(row.cc, 8192, 'cc'),
      dateHeader,
      textPreview: text(row.text_preview, 1024, 'text_preview'),
    },
    bcc: text(row.bcc, 8192, 'bcc'),
    sourceMessageId: text(row.source_message_id, 128, 'source_message_id'),
    composeMode: text(row.compose_mode, 64, 'compose_mode'),
    sendStatus: text(row.send_status, 64, 'send_status'),
    provider: text(row.provider, 64, 'provider'),
    dateHeader,
  };
}

export async function loadLegacyRaw(source, message) {
  const object = source.snapshotStatement.get(message.rawKey);
  if (object === undefined || object.status !== 'ready') throw new Error('raw snapshot object is not ready');
  if (
    String(object.expected_raw_sha256) !== message.rawSha256
    || Number(object.expected_raw_size) !== message.rawSize
    || (Number(object.compressed) === 1) !== message.compressed
  ) throw new Error('raw snapshot metadata differs from legacy D1');
  const path = resolveLegacySnapshotFile(source.snapshotRoot, object.file);
  const info = await stat(path);
  if (info.size < 1 || info.size > MAX_LEGACY_RAW_BYTES + 1024 * 1024) {
    throw new Error('raw snapshot stored size is invalid');
  }
  const stored = await readFile(path);
  if (stored.byteLength !== Number(object.stored_size) || sha256(stored) !== object.stored_sha256) {
    throw new Error('raw snapshot stored hash differs from snapshot metadata');
  }
  const raw = message.compressed ? await gunzipAsync(stored) : stored;
  if (raw.byteLength !== message.rawSize || sha256(raw) !== message.rawSha256) {
    throw new Error('raw snapshot content differs from legacy D1');
  }
  return raw;
}

export function requireMatchingAttachments(source, sourceMessageId, attachments) {
  const expected = source.attachmentStatement.all(sourceMessageId).map((row) => {
    if (row.sha256 === null || row.sha256 === undefined) throw new Error('legacy attachment blob is missing');
    return `${hash(row.sha256, 'attachment sha256')}:${integer(row.size, 0, MAX_LEGACY_RAW_BYTES, 'attachment size')}`;
  }).sort();
  const actual = attachments.map((attachment) => `${attachment.sha256}:${attachment.size}`).sort();
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    throw new Error('MIME attachments do not match legacy D1 blob metadata');
  }
}

function text(value, maximum, name, required = false) {
  const normalized = value === null || value === undefined ? '' : String(value);
  if ((required && normalized.length === 0) || normalized.length > maximum || /[\u0000]/u.test(normalized)) {
    throw new Error(`legacy ${name} is invalid`);
  }
  return normalized;
}

function hash(value, name) {
  const normalized = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new Error(`legacy ${name} is invalid`);
  return normalized;
}

function positive(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`legacy ${name} is invalid`);
  return parsed;
}

function optionalPositive(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function integer(value, minimum, maximum, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`legacy ${name} is invalid`);
  }
  return parsed;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
