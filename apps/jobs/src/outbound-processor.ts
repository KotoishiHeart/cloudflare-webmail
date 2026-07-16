import type { OutboundQueueMessage } from '@cf-webmail/contracts';
import {
  claimOutboundDelivery,
  completeOutboundDelivery,
  exhaustOutboundDelivery,
  failOutboundDelivery,
  getOutboundDeliveryMessage,
  recordDeliveryEventSafely,
} from '@cf-webmail/database';
import { PermanentOutboundError, RetryableOutboundError } from './outbound-errors.js';
import { loadOutboundAttachments } from './outbound-attachment-loader.js';

const PERMANENT_EMAIL_CODES = new Set([
  'E_VALIDATION_ERROR',
  'E_FIELD_MISSING',
  'E_TOO_MANY_RECIPIENTS',
  'E_TOO_MANY_ATTACHMENTS',
  'E_SENDER_NOT_VERIFIED',
  'E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_CONTENT_TOO_LARGE',
  'E_HEADER_NOT_ALLOWED',
  'E_HEADER_USE_API_FIELD',
  'E_HEADER_VALUE_INVALID',
  'E_HEADER_VALUE_TOO_LONG',
  'E_HEADER_NAME_INVALID',
  'E_HEADERS_TOO_LARGE',
  'E_HEADERS_TOO_MANY',
]);

export type OutboundProcessorDependencies = {
  db: D1Database;
  rawEmails: Pick<R2Bucket, 'get'>;
  email: SendEmail;
  now(): number;
};

export type OutboundProcessResult = 'sent' | 'already-finished';

export async function processOutboundQueueMessage(
  queueMessage: OutboundQueueMessage,
  dependencies: OutboundProcessorDependencies,
): Promise<OutboundProcessResult> {
  const current = await getOutboundDeliveryMessage(
    dependencies.db,
    queueMessage.messageId,
    queueMessage.mailboxId,
  );
  if (current === null) {
    throw new RetryableOutboundError('delivery_not_found', 'outbound delivery record was not found');
  }
  if (current.status === 'sent' || current.status === 'failed') return 'already-finished';
  if (current.attemptCount >= 10) {
    const now = dependencies.now();
    const exhausted = await exhaustOutboundDelivery(dependencies.db, current.messageId, now);
    if (!exhausted) throw new RetryableOutboundError('delivery_busy', 'outbound delivery is not claimable');
    await recordDeliveryEventSafely(dependencies.db, {
      direction: 'outbound', stage: 'provider', status: 'failed',
      category: 'retry_exhausted', severity: 'high', mailboxId: current.mailboxId,
      messageId: current.messageId, provider: 'cloudflare-email-service',
      errorCode: 'retry_exhausted', summary: 'Outbound retry limit reached', now,
    });
    throw new PermanentOutboundError('retry_exhausted', 'outbound retry limit reached');
  }

  const claimTime = dependencies.now();
  const leaseToken = crypto.randomUUID();
  const claimed = await claimOutboundDelivery(
    dependencies.db,
    current.messageId,
    leaseToken,
    claimTime,
  );
  if (!claimed) {
    const latest = await getOutboundDeliveryMessage(
      dependencies.db,
      queueMessage.messageId,
      queueMessage.mailboxId,
    );
    if (latest?.status === 'sent' || latest?.status === 'failed') return 'already-finished';
    throw new RetryableOutboundError('delivery_busy', 'outbound delivery is not claimable');
  }

  try {
    const [text, html, attachments] = await Promise.all([
      getBody(dependencies.rawEmails, current.bodyTextKey, 'text'),
      getBody(dependencies.rawEmails, current.bodyHtmlKey, 'html'),
      loadOutboundAttachments(dependencies.rawEmails, current.attachments),
    ]);
    const destinations = destinationFields(current.to, current.cc, current.bcc);
    const response = await dependencies.email.send({
      ...destinations,
      from: { email: current.senderAddress, name: current.senderName },
      subject: current.subject,
      text,
      html,
      headers: deliveryHeaders(current),
      ...(attachments.length === 0 ? {} : { attachments }),
    });
    const completed = await completeOutboundDelivery(
      dependencies.db,
      current.messageId,
      leaseToken,
      response.messageId,
      dependencies.now(),
    );
    if (!completed) {
      throw new PermanentOutboundError(
        'delivery_lease_lost_after_send',
        'delivery lease was lost after Email Service accepted the message',
      );
    }
    await recordDeliveryEventSafely(dependencies.db, {
      direction: 'outbound', stage: 'completed', status: 'succeeded',
      category: 'message_sent', mailboxId: current.mailboxId,
      messageId: current.messageId, provider: 'cloudflare-email-service',
      summary: 'Email Service accepted the outbound message',
      details: { providerMessageId: response.messageId }, now: dependencies.now(),
    });
    return 'sent';
  } catch (error) {
    const emailError = normalizeEmailError(error);
    const permanent = error instanceof PermanentOutboundError
      || PERMANENT_EMAIL_CODES.has(emailError.code);
    const now = dependencies.now();
    await failOutboundDelivery(
      dependencies.db,
      current.messageId,
      leaseToken,
      emailError.code,
      emailError.message,
      permanent,
      permanent ? now : now + retryDelayMilliseconds(current.attemptCount + 1),
      now,
    );
    await recordDeliveryEventSafely(dependencies.db, {
      direction: 'outbound', stage: 'provider',
      status: permanent ? 'failed' : 'retrying',
      category: permanent ? 'provider_rejected' : 'provider_retry',
      severity: permanent ? 'high' : 'medium', mailboxId: current.mailboxId,
      messageId: current.messageId, provider: 'cloudflare-email-service',
      errorCode: emailError.code, summary: emailError.message,
      details: { attempt: current.attemptCount + 1 }, now,
    });
    if (permanent) throw new PermanentOutboundError(emailError.code, emailError.message);
    throw new RetryableOutboundError(emailError.code, emailError.message);
  }
}

function deliveryHeaders(current: {
  messageId: string;
  inReplyTo: string;
  referencesHeader: string;
}): Record<string, string> {
  return {
    'X-CF-Webmail-Delivery-ID': current.messageId,
    ...(current.inReplyTo === '' ? {} : { 'In-Reply-To': current.inReplyTo }),
    ...(current.referencesHeader === '' ? {} : { References: current.referencesHeader }),
  };
}

function destinationFields(to: string[], cc: string[], bcc: string[]): EmailDestinations {
  const optional = {
    ...(cc.length > 0 ? { cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
  };
  if (to.length > 0) return { to, ...optional };
  if (cc.length > 0) return { cc, ...(bcc.length > 0 ? { bcc } : {}) };
  if (bcc.length > 0) return { bcc };
  throw new PermanentOutboundError('recipient_missing', 'outbound message has no recipients');
}

async function getBody(
  bucket: Pick<R2Bucket, 'get'>,
  key: string,
  kind: string,
): Promise<string> {
  const object = await bucket.get(key);
  if (object === null) throw new Error(`outbound ${kind} body object is missing`);
  return object.text();
}

function normalizeEmailError(error: unknown): { code: string; message: string } {
  if (error instanceof PermanentOutboundError || error instanceof RetryableOutboundError) {
    return { code: error.code, message: error.message };
  }
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate?.code === 'string' && candidate.code.trim() !== ''
    ? candidate.code
    : 'E_INTERNAL_PROCESSING_ERROR';
  const message = typeof candidate?.message === 'string' && candidate.message.trim() !== ''
    ? candidate.message
    : 'outbound delivery failed';
  return { code, message };
}

function retryDelayMilliseconds(attempt: number): number {
  const exponent = Math.max(0, Math.min(7, Math.floor(attempt) - 1));
  return Math.min(30 * (2 ** exponent), 3600) * 1000;
}
