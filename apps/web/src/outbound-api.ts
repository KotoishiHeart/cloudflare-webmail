import {
  findOutboundByIdempotency,
  getOutboundComposeContext,
  mailboxRoleGrants,
  normalizeIdempotencyKey,
  persistOutboundMessage,
  resolveOutboundThreadContext,
  type OutboundRecipient,
  type StoredOutboundRequest,
} from '@cf-webmail/database';
import { createOutboundQueueMessage } from '@cf-webmail/contracts';
import type { AccessIdentity } from './access-auth.js';
import { ApiInputError, requestIsSameOrigin } from './api-input.js';
import { apiData, apiError } from './api-response.js';
import { readComposeInput } from './compose-input.js';
import { buildOutboundArchive, MAX_OUTBOUND_ARCHIVE_BYTES } from './outbound-archive.js';

type OutboundApiEnv = Pick<Env, 'DB' | 'RAW_EMAILS' | 'OUTBOUND_QUEUE'>;

export async function createOutboundMessage(
  request: Request,
  env: OutboundApiEnv,
  identity: AccessIdentity,
  mailboxId: string,
  now: number,
): Promise<Response> {
  if (!requestIsSameOrigin(request)) return apiError('cross_origin_request_denied', 403);
  const context = await getOutboundComposeContext(env.DB, identity, mailboxId);
  if (context === null) return apiError('mailbox_not_found', 404);
  if (!mailboxRoleGrants(context.role, 'operate')) return apiError('insufficient_role', 403);

  const idempotencyHeader = request.headers.get('idempotency-key');
  if (idempotencyHeader === null) throw new ApiInputError('Idempotency-Key is required');
  const idempotencyKey = normalizeIdempotencyKey(idempotencyHeader);
  const existing = await findOutboundByIdempotency(env.DB, mailboxId, idempotencyKey);
  if (existing !== null) {
    await enqueue(env.OUTBOUND_QUEUE, existing);
    return apiData(publicRequest(existing, false), 200);
  }

  const input = await readComposeInput(request);
  const thread = await resolveOutboundThreadContext(
    env.DB,
    context.mailboxId,
    input.composeMode,
    input.sourceMessageId,
  );
  const messageId = crypto.randomUUID();
  const archive = buildOutboundArchive(
    messageId,
    context.address,
    context.displayName,
    input,
    thread,
    now,
  );
  if (archive.raw.byteLength > MAX_OUTBOUND_ARCHIVE_BYTES) {
    throw new ApiInputError('composed message exceeds the 5 MiB Email Service limit');
  }
  const prefix = `mailboxes/${context.mailboxId}/messages/${messageId}`;
  const rawKey = `${prefix}/raw.eml`;
  const bodyTextKey = `${prefix}/body.txt`;
  const bodyHtmlKey = `${prefix}/body.html`;
  const objectKeys = [rawKey, bodyTextKey, bodyHtmlKey];
  const rawSha256 = await sha256Hex(archive.raw);

  let persisted = false;
  try {
    const rawObject = await env.RAW_EMAILS.put(rawKey, archive.raw, {
      httpMetadata: { contentType: 'message/rfc822' },
      customMetadata: outboundMetadata(messageId, context.mailboxId, 'raw', rawSha256),
    });
    await env.RAW_EMAILS.put(bodyTextKey, input.text, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      customMetadata: outboundMetadata(messageId, context.mailboxId, 'body-text'),
    });
    await env.RAW_EMAILS.put(bodyHtmlKey, archive.html, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
      customMetadata: outboundMetadata(messageId, context.mailboxId, 'body-html'),
    });
    const result = await persistOutboundMessage(env.DB, {
      id: messageId,
      mailboxId: context.mailboxId,
      requestedByUserId: context.userId,
      idempotencyKey,
      sender: `${context.displayName} <${context.address}>`,
      senderAddress: context.address,
      recipients: recipients(input),
      subject: input.subject,
      textPreview: input.text.replace(/\s+/gu, ' ').trim().slice(0, 1024),
      rawKey,
      rawSha256,
      rawEtag: rawObject.etag,
      rawSize: archive.raw.byteLength,
      bodyTextKey,
      bodyHtmlKey,
      archiveMessageId: archive.archiveMessageId,
      ...thread,
      createdAt: now,
    });
    persisted = result.created;
    if (!result.created) await env.RAW_EMAILS.delete(objectKeys);
    await enqueue(env.OUTBOUND_QUEUE, result.request);
    return apiData(publicRequest(result.request, result.created), result.created ? 202 : 200);
  } catch (error) {
    if (!persisted) await env.RAW_EMAILS.delete(objectKeys).catch(() => undefined);
    throw error;
  }
}

function recipients(input: Awaited<ReturnType<typeof readComposeInput>>): OutboundRecipient[] {
  return (['to', 'cc', 'bcc'] as const).flatMap((kind) =>
    input[kind].map((address, ordinal) => ({ kind, ordinal, address })),
  );
}

async function enqueue(
  queue: Queue<unknown>,
  request: StoredOutboundRequest,
): Promise<void> {
  try {
    await queue.send(createOutboundQueueMessage(request.messageId, request.mailboxId), {
      contentType: 'json',
    });
  } catch {
    throw new OutboundQueueUnavailableError();
  }
}

export class OutboundQueueUnavailableError extends Error {}

function publicRequest(request: StoredOutboundRequest, created: boolean) {
  return {
    messageId: request.messageId,
    mailboxId: request.mailboxId,
    status: request.status,
    providerMessageId: request.providerMessageId || null,
    created,
  };
}

function outboundMetadata(
  messageId: string,
  mailboxId: string,
  kind: string,
  sha256?: string,
): Record<string, string> {
  return {
    schemaVersion: '1',
    direction: 'outbound',
    messageId,
    mailboxId,
    kind,
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const source = value.slice().buffer;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
