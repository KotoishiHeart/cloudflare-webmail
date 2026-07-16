import type { InboundQueueMessage } from '@cf-webmail/contracts';
import type { PreparedMessage } from './prepared-message.js';
import { loadValidatedStagedRaw } from './staged-raw.js';

export async function storePreparedMessage(
  bucket: Pick<R2Bucket, 'get' | 'put'>,
  queueMessage: InboundQueueMessage,
  prepared: PreparedMessage,
  rawSha256: string,
): Promise<{ rawEtag: string }> {
  const staged = await loadValidatedStagedRaw(bucket, queueMessage);
  const rawStream = staged.body.pipeThrough(new FixedLengthStream(staged.size));
  const rawObject = await bucket.put(prepared.rawKey, rawStream, {
    httpMetadata: { contentType: 'message/rfc822' },
    customMetadata: internalMetadata(queueMessage, 'raw', rawSha256),
  });
  requireStoredSize(rawObject, staged.size, 'raw');

  if (prepared.bodyTextKey !== null) {
    await putText(bucket, prepared.bodyTextKey, prepared.bodyText, 'text/plain; charset=utf-8',
      internalMetadata(queueMessage, 'body-text'));
  }
  if (prepared.bodyHtmlKey !== null) {
    await putText(bucket, prepared.bodyHtmlKey, prepared.bodyHtml, 'text/html; charset=utf-8',
      internalMetadata(queueMessage, 'body-html'));
  }
  for (const attachment of prepared.attachments) {
    const object = await bucket.put(attachment.storageKey, attachment.content, {
      httpMetadata: { contentType: attachment.contentType },
      customMetadata: internalMetadata(queueMessage, 'attachment', attachment.sha256),
    });
    requireStoredSize(object, attachment.size, 'attachment');
  }
  return { rawEtag: rawObject.etag };
}

async function putText(
  bucket: Pick<R2Bucket, 'put'>,
  key: string,
  value: string,
  contentType: string,
  customMetadata: Record<string, string>,
): Promise<void> {
  const object = await bucket.put(key, value, {
    httpMetadata: { contentType },
    customMetadata,
  });
  requireStoredSize(object, new TextEncoder().encode(value).byteLength, 'body');
}

function internalMetadata(
  message: InboundQueueMessage,
  kind: string,
  sha256?: string,
): Record<string, string> {
  return {
    schemaVersion: String(message.schemaVersion),
    messageId: message.messageId,
    mailboxId: message.mailboxId,
    kind,
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

function requireStoredSize(object: R2Object, expected: number, kind: string): void {
  if (object.size !== expected) throw new Error(`R2 ${kind} object size mismatch`);
}
