import type { InboundQueueMessage } from '@cf-webmail/contracts';

const RAW_KEY_PREFIX = 'staging/raw';

type RawKeyReceipt = {
  messageId: string;
  receivedAt: number;
};

export function buildRawEmailKey(receipt: RawKeyReceipt, mailboxId: string): string {
  const date = new Date(receipt.receivedAt);
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  return `${RAW_KEY_PREFIX}/${year}/${month}/${day}/${mailboxId}/${receipt.messageId}.eml`;
}

export async function stageRawEmail(
  bucket: Pick<R2Bucket, 'put'>,
  raw: ReadableStream<Uint8Array>,
  queueMessage: InboundQueueMessage,
  mailboxId: string,
): Promise<R2Object> {
  const fixedLength = new FixedLengthStream(queueMessage.staging.rawSize);
  const pipe = raw.pipeTo(fixedLength.writable);
  const put = bucket.put(queueMessage.rawKey, fixedLength.readable, {
    httpMetadata: { contentType: 'message/rfc822' },
    customMetadata: {
      schemaVersion: String(queueMessage.schemaVersion),
      messageId: queueMessage.messageId,
      mailboxId,
      receivedAt: String(queueMessage.receivedAt),
      rawSize: String(queueMessage.staging.rawSize),
    },
  });
  const [object] = await Promise.all([put, pipe]);
  if (object === null || object.size !== queueMessage.staging.rawSize) {
    throw new Error('R2 did not persist the expected raw message length');
  }
  return object;
}
