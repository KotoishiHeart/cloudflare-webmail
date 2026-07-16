import type { InboundQueueMessage } from '@cf-webmail/contracts';
import { PermanentInboundError } from './inbound-errors.js';

export async function loadValidatedStagedRaw(
  bucket: Pick<R2Bucket, 'get'>,
  message: InboundQueueMessage,
): Promise<R2ObjectBody> {
  const object = await bucket.get(message.rawKey);
  if (object === null) {
    throw new PermanentInboundError('staging-missing', 'staged raw message was not found');
  }
  if (object.size !== message.staging.rawSize) {
    throw new PermanentInboundError('staging-size-mismatch', 'staged raw size does not match');
  }

  const metadata = object.customMetadata;
  if (
    metadata?.schemaVersion !== String(message.schemaVersion)
    || metadata.messageId !== message.messageId
    || metadata.mailboxId !== message.mailboxId
    || metadata.rawSize !== String(message.staging.rawSize)
  ) {
    throw new PermanentInboundError('staging-metadata-mismatch', 'staged metadata does not match');
  }
  return object;
}
