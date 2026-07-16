import type {
  OutboundComposeMode,
  OutboundThreadContext,
} from './outbound-domain.js';
import { DatabaseInputError, normalizeId } from './validation.js';

const MAX_REFERENCES_BYTES = 2048;
const MAX_REFERENCES_ENTRIES = 100;

type ThreadSourceRow = {
  rfc_message_id: string;
  references_header: string;
};

export async function resolveOutboundThreadContext(
  db: D1Database,
  mailboxIdInput: string,
  composeMode: OutboundComposeMode,
  sourceMessageIdInput: string | null,
): Promise<OutboundThreadContext> {
  const mailboxId = normalizeId(mailboxIdInput, 'mailboxId');
  if (composeMode === 'new') {
    if (sourceMessageIdInput !== null) {
      throw new DatabaseInputError('sourceMessageId', 'must be omitted for a new message');
    }
    return emptyContext();
  }
  if (sourceMessageIdInput === null) {
    throw new DatabaseInputError('sourceMessageId', `is required for ${composeMode}`);
  }
  const sourceMessageId = normalizeId(sourceMessageIdInput, 'sourceMessageId');
  const source = await db.prepare(`
    SELECT rfc_message_id, references_header
    FROM messages
    WHERE id = ? AND mailbox_id = ?
    LIMIT 1
  `).bind(sourceMessageId, mailboxId).first<ThreadSourceRow>();
  if (source === null) {
    throw new DatabaseInputError('sourceMessageId', 'does not belong to the selected mailbox');
  }
  if (composeMode === 'forward') {
    return {
      composeMode,
      sourceMessageId,
      inReplyTo: '',
      referencesHeader: '',
    };
  }
  const inReplyTo = firstMessageId(source.rfc_message_id);
  return {
    composeMode,
    sourceMessageId,
    inReplyTo,
    referencesHeader: buildReferences(source.references_header, inReplyTo),
  };
}

function emptyContext(): OutboundThreadContext {
  return {
    composeMode: 'new',
    sourceMessageId: null,
    inReplyTo: '',
    referencesHeader: '',
  };
}

function firstMessageId(value: string): string {
  return messageIds(value)[0] ?? '';
}

function buildReferences(existing: string, inReplyTo: string): string {
  const unique = [...new Set([...messageIds(existing), ...messageIds(inReplyTo)])]
    .slice(-MAX_REFERENCES_ENTRIES);
  while (new TextEncoder().encode(unique.join(' ')).byteLength > MAX_REFERENCES_BYTES) {
    unique.shift();
  }
  return unique.join(' ');
}

function messageIds(value: string): string[] {
  return value.match(/<[^<>\r\n]{1,996}>/gu) ?? [];
}
