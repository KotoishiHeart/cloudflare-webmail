import { DatabaseInputError } from '@cf-webmail/database';
import type { AccessIdentity } from './access-auth.js';
import { ApiInputError, UnsupportedMediaTypeError } from './api-input.js';
import { apiError } from './api-response.js';
import {
  getMessageDetail,
  getMessageList,
  patchMessage,
} from './message-api.js';
import {
  downloadMessageAttachment,
  downloadRawMessage,
  getMessageBody,
} from './message-object-api.js';
import { getSession } from './session-api.js';
import {
  createOutboundMessage,
  OutboundQueueUnavailableError,
} from './outbound-api.js';
import { ComposeMediaTypeError } from './compose-input.js';

export async function routeApi(
  request: Request,
  env: Pick<Env, 'DB' | 'RAW_EMAILS' | 'OUTBOUND_QUEUE'>,
  identity: AccessIdentity,
  now: number,
): Promise<Response> {
  try {
    return await routeKnownApi(request, env, identity, now);
  } catch (error) {
    if (error instanceof UnsupportedMediaTypeError || error instanceof ComposeMediaTypeError) {
      return apiError('unsupported_media_type', 415);
    }
    if (error instanceof ApiInputError || error instanceof DatabaseInputError) {
      return apiError('invalid_request', 400);
    }
    if (error instanceof OutboundQueueUnavailableError) {
      return apiError('outbound_queue_unavailable', 503);
    }
    throw error;
  }
}

async function routeKnownApi(
  request: Request,
  env: Pick<Env, 'DB' | 'RAW_EMAILS' | 'OUTBOUND_QUEUE'>,
  identity: AccessIdentity,
  now: number,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/api/session') {
    return request.method === 'GET'
      ? getSession(env.DB, identity)
      : apiError('method_not_allowed', 405, 'GET');
  }

  const mailboxList = pathname.match(/^\/api\/mailboxes\/([^/]+)\/messages$/u);
  if (mailboxList !== null) {
    if (request.method === 'GET') {
      return getMessageList(request, env.DB, identity, mailboxList[1] ?? '');
    }
    if (request.method === 'POST') {
      return createOutboundMessage(request, env, identity, mailboxList[1] ?? '', now);
    }
    return apiError('method_not_allowed', 405, 'GET, POST');
  }

  const attachment = pathname.match(/^\/api\/messages\/([^/]+)\/attachments\/(\d+)$/u);
  if (attachment !== null) {
    const ordinal = Number(attachment[2]);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 99) {
      return apiError('invalid_request', 400);
    }
    return request.method === 'GET'
      ? downloadMessageAttachment(
        env.RAW_EMAILS,
        env.DB,
        identity,
        attachment[1] ?? '',
        ordinal,
      )
      : apiError('method_not_allowed', 405, 'GET');
  }

  const object = pathname.match(/^\/api\/messages\/([^/]+)\/(body|raw)$/u);
  if (object !== null) {
    if (request.method !== 'GET') return apiError('method_not_allowed', 405, 'GET');
    return object[2] === 'body'
      ? getMessageBody(env.RAW_EMAILS, env.DB, identity, object[1] ?? '')
      : downloadRawMessage(env.RAW_EMAILS, env.DB, identity, object[1] ?? '');
  }

  const message = pathname.match(/^\/api\/messages\/([^/]+)$/u);
  if (message !== null) {
    if (request.method === 'GET') {
      return getMessageDetail(env.DB, identity, message[1] ?? '');
    }
    if (request.method === 'PATCH') {
      return patchMessage(request, env.DB, identity, message[1] ?? '', now);
    }
    return apiError('method_not_allowed', 405, 'GET, PATCH');
  }
  return apiError('not_found', 404);
}
