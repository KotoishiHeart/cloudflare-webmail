import {
  getAuthorizedWebMessage,
  mailboxRoleGrants,
  recordDeliveryEventSafely,
  retryOutboundDelivery,
} from '@cf-webmail/database';
import type { AccessIdentity } from './access-auth.js';
import { requestIsSameOrigin } from './api-input.js';
import { apiData, apiError } from './api-response.js';
import {
  enqueue,
  type OutboundApiEnv,
} from './outbound-api.js';

export async function retryOutboundMessage(
  request: Request,
  env: OutboundApiEnv,
  identity: AccessIdentity,
  messageId: string,
  now: number,
): Promise<Response> {
  if (!requestIsSameOrigin(request)) return apiError('cross_origin_request_denied', 403);
  const message = await getAuthorizedWebMessage(env.DB, identity, messageId);
  if (message === null) return apiError('message_not_found', 404);
  if (!mailboxRoleGrants(message.role, 'operate')) {
    return apiError('insufficient_role', 403);
  }
  if (message.direction !== 'outbound') return apiError('message_not_outbound', 409);
  if (message.status !== 'failed') return apiError('outbound_not_failed', 409);

  const queued = await retryOutboundDelivery(env.DB, message.id, message.mailboxId, now);
  if (!queued) return apiError('outbound_not_failed', 409);
  try {
    await enqueue(env.OUTBOUND_QUEUE, {
      messageId: message.id,
      mailboxId: message.mailboxId,
    });
  } catch (error) {
    await recordDeliveryEventSafely(env.DB, {
      direction: 'outbound', stage: 'queue', status: 'retrying',
      category: 'outbound_retry_queue_failed', severity: 'high',
      mailboxId: message.mailboxId, messageId: message.id,
      errorCode: 'outbound_queue_unavailable',
      summary: error instanceof Error ? error.message : 'Outbound retry queue was unavailable',
      now,
    });
    throw error;
  }
  await recordDeliveryEventSafely(env.DB, {
    direction: 'outbound', stage: 'queue', status: 'retrying',
    category: 'outbound_retry_requested', severity: 'medium',
    mailboxId: message.mailboxId, messageId: message.id,
    summary: 'Outbound resend requested', now,
  });
  return apiData({ messageId: message.id, mailboxId: message.mailboxId, status: 'queued' }, 202);
}

export function routeOutboundRetry(
  request: Request,
  env: OutboundApiEnv,
  identity: AccessIdentity,
  messageId: string,
  now: number,
): Promise<Response> {
  return request.method === 'POST'
    ? retryOutboundMessage(request, env, identity, messageId, now)
    : Promise.resolve(apiError('method_not_allowed', 405, 'POST'));
}
