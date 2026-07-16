import {
  getUserPreferences,
  saveUserPreferences,
  validatePreferences,
} from '@cf-webmail/database';
import type { AccessIdentity } from './access-auth.js';
import { requestIsSameOrigin } from './api-input.js';
import { apiData, apiError } from './api-response.js';
import { readPreferencePatch } from './label-input.js';

export async function preferencesResponse(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  now: number,
): Promise<Response> {
  const current = await getUserPreferences(db, identity);
  if (current === null) return apiError('identity_not_linked', 404);
  if (request.method === 'GET') return apiData({ preferences: current.preferences });
  if (request.method !== 'PATCH') return apiError('method_not_allowed', 405, 'GET, PATCH');
  if (!requestIsSameOrigin(request)) return apiError('cross_origin_request_denied', 403);
  const preferences = { ...current.preferences, ...await readPreferencePatch(request) };
  validatePreferences(preferences);
  await saveUserPreferences(db, current.userId, preferences, now);
  return apiData({ preferences });
}
