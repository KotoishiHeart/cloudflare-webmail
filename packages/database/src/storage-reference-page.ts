export type StorageReference = {
  objectKey: string;
  mailboxId: string;
  messageId: string;
  kind: string;
};

export type StorageReferencePage = {
  references: StorageReference[];
  nextCursor: string;
};

type StorageReferenceCursor = {
  messageId: string;
  referenceOffset: number;
};

type StorageReferenceRow = {
  mailbox_id: string;
  message_id: string;
  raw_key: string;
  body_text_key: string | null;
  body_html_key: string | null;
  storage_key: string | null;
};

export async function listStorageReferences(
  db: D1Database,
  cursor: string,
  limit = 50,
): Promise<StorageReference[]> {
  return (await listStorageReferencePage(db, cursor, limit)).references;
}

export async function listStorageReferencePage(
  db: D1Database,
  cursor: string,
  limit = 50,
): Promise<StorageReferencePage> {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const position = parseReferenceCursor(cursor);
  // Every message has a raw reference, so fetching at most one message per
  // requested reference fills the page without scanning past the PK range.
  const comparison = position.referenceOffset === 0 ? '>' : '>=';
  const messageLimit = boundedLimit + (position.referenceOffset === 0 ? 0 : 1);
  const rows = await db.prepare(`
    SELECT m.id AS message_id, m.mailbox_id, m.raw_key,
      m.body_text_key, m.body_html_key, a.storage_key
    FROM (
      SELECT id, mailbox_id, raw_key, body_text_key, body_html_key
      FROM messages
      WHERE id ${comparison} ?
      ORDER BY id
      LIMIT ?
    ) AS m
    LEFT JOIN attachments AS a ON a.message_id = m.id
    ORDER BY m.id, a.ordinal
  `).bind(position.messageId, messageLimit).all<StorageReferenceRow>();
  const messages = groupReferences(rows.results);
  const page: StorageReference[] = [];
  for (const [messageId, references] of messages) {
    const start = messageId === position.messageId ? position.referenceOffset : 0;
    for (let index = start; index < references.length; index += 1) {
      page.push(references[index]!);
      if (page.length === boundedLimit) {
        const nextOffset = index + 1;
        return {
          references: page,
          nextCursor: encodeReferenceCursor(
            messageId,
            nextOffset < references.length ? nextOffset : 0,
          ),
        };
      }
    }
  }
  return { references: page, nextCursor: '' };
}

function groupReferences(rows: StorageReferenceRow[]): Map<string, StorageReference[]> {
  const messages = new Map<string, StorageReference[]>();
  for (const row of rows) {
    let references = messages.get(row.message_id);
    if (references === undefined) {
      references = [];
      addReference(references, row.raw_key, row, 'raw');
      if (row.body_text_key !== null) addReference(references, row.body_text_key, row, 'body_text');
      if (row.body_html_key !== null) addReference(references, row.body_html_key, row, 'body_html');
      messages.set(row.message_id, references);
    }
    if (row.storage_key !== null) addReference(references, row.storage_key, row, 'attachment');
  }
  return messages;
}

function addReference(
  references: StorageReference[],
  objectKey: string,
  row: Pick<StorageReferenceRow, 'mailbox_id' | 'message_id'>,
  kind: string,
): void {
  if (references.some((reference) => reference.objectKey === objectKey)) return;
  references.push({
    objectKey,
    mailboxId: row.mailbox_id,
    messageId: row.message_id,
    kind,
  });
}

function parseReferenceCursor(cursor: string): StorageReferenceCursor {
  if (cursor === '') return { messageId: '', referenceOffset: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    // Cursors from the previous release were plain message IDs.
    if (cursor.length <= 128) return { messageId: cursor, referenceOffset: 0 };
    throw new Error('canonical reference cursor is invalid');
  }
  if (
    typeof parsed === 'object'
    && parsed !== null
    && 'messageId' in parsed
    && 'referenceOffset' in parsed
    && typeof parsed.messageId === 'string'
    && parsed.messageId.length <= 128
    && Number.isSafeInteger(parsed.referenceOffset)
    && typeof parsed.referenceOffset === 'number'
    && parsed.referenceOffset >= 0
    && parsed.referenceOffset <= 103
  ) {
    return { messageId: parsed.messageId, referenceOffset: parsed.referenceOffset };
  }
  throw new Error('canonical reference cursor is invalid');
}

function encodeReferenceCursor(messageId: string, referenceOffset: number): string {
  return JSON.stringify({ messageId, referenceOffset });
}
