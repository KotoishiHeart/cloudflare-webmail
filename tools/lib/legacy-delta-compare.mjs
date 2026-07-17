import { createHash } from 'node:crypto';

const IMMUTABLE_FIELDS = [
  'id', 'direction', 'message_id', 'raw_sha256', 'subject', 'sender', 'recipients', 'cc',
  'date_header', 'received_at', 'text_preview', 'raw_key', 'body_text_key', 'body_html_key',
  'raw_size', 'has_attachments', 'compressed', 'created_at', 'account_email', 'bcc', 'in_reply_to',
  'references_header', 'source_message_id', 'compose_mode', 'send_status', 'provider',
];
const NUMBER_FIELDS = new Set([
  'received_at', 'raw_size', 'has_attachments', 'compressed', 'created_at', 'is_read', 'starred', 'archived',
  'deleted', 'deleted_at',
]);

export function changedLegacyImmutableFields(baseline, final) {
  return IMMUTABLE_FIELDS.filter(
    (field) => normalized(baseline[field], field) !== normalized(final[field], field),
  );
}

export function legacyFlags(row) {
  return {
    isRead: Number(row.is_read) !== 0,
    isStarred: Number(row.starred) !== 0,
    isArchived: Number(row.archived) !== 0,
    isDeleted: Number(row.deleted) !== 0,
    deletedAt: optionalPositive(row.deleted_at),
  };
}

export function legacyFlagsChanged(baseline, final) {
  return JSON.stringify(legacyFlags(baseline)) !== JSON.stringify(legacyFlags(final));
}

export function legacyDeltaExpectedSha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function readLegacyAttachmentFingerprints(database) {
  const rows = database.prepare(`
    SELECT a.message_id, a.filename, a.content_type, CAST(a.size AS INTEGER) AS size,
      a.blob_sha256, b.sha256
    FROM attachments AS a LEFT JOIN blobs AS b ON b.sha256 = a.blob_sha256
    ORDER BY a.message_id, CAST(a.id AS INTEGER), a.filename
  `).all();
  const grouped = new Map();
  for (const row of rows) {
    if (row.sha256 === null || row.sha256 === undefined) {
      throw new Error(`legacy attachment blob is missing for message ${String(row.message_id)}`);
    }
    const id = String(row.message_id);
    const values = grouped.get(id) ?? [];
    values.push([
      String(row.filename ?? ''), String(row.content_type ?? ''), Number(row.size),
      String(row.blob_sha256 ?? ''), String(row.sha256),
    ]);
    grouped.set(id, values);
  }
  return new Map([...grouped].map(([id, values]) => [id, JSON.stringify(values)]));
}

function normalized(value, field) {
  if (NUMBER_FIELDS.has(field)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return value === null || value === undefined ? '' : String(value);
}

function optionalPositive(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
