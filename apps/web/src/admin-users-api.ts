import {
  addAdminAccessIdentity,
  getAdminUserDetail,
  grantSystemAdministrator,
  listAdminUsers,
  provisionUserWithIdentity,
  removeAdminAccessIdentity,
  setAdminGrant,
  updateAdminUser,
  type SystemAdministrator,
} from '@cf-webmail/database';
import { apiData, apiError } from './api-response.js';
import {
  readAdminIdentity,
  readAdminUserPatch,
  readCreateAdminUser,
} from './admin-input.js';

export async function adminUsersCollection(
  request: Request,
  db: D1Database,
  administrator: SystemAdministrator,
  now: number,
): Promise<Response> {
  if (request.method === 'GET') return apiData({ users: await listAdminUsers(db) });
  if (request.method !== 'POST') return apiError('method_not_allowed', 405, 'GET, POST');
  const input = await readCreateAdminUser(request);
  const userId = crypto.randomUUID();
  await provisionUserWithIdentity(db, {
    userId,
    email: input.email,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    identity: input.identity,
    now,
  });
  if (input.isSystemAdmin) {
    await grantSystemAdministrator(db, {
      userId, grantedByUserId: administrator.userId, source: 'admin', now,
    });
  }
  return apiData({ user: await getAdminUserDetail(db, userId) }, 201);
}

export async function adminUserResource(
  request: Request,
  db: D1Database,
  administrator: SystemAdministrator,
  userId: string,
  now: number,
): Promise<Response> {
  if (request.method === 'GET') {
    const detail = await getAdminUserDetail(db, userId);
    return detail === null ? apiError('user_not_found', 404) : apiData(detail);
  }
  if (request.method !== 'PATCH') return apiError('method_not_allowed', 405, 'GET, PATCH');
  const result = await updateAdminUser(db, {
    userId, actorUserId: administrator.userId, patch: await readAdminUserPatch(request), now,
  });
  if (result === 'not-found') return apiError('user_not_found', 404);
  if (result === 'self-disable-denied') return apiError('cannot_disable_current_administrator', 409);
  if (result === 'administrator-disable-denied') {
    return apiError('revoke_administrator_before_disabling_user', 409);
  }
  return apiData({ user: await getAdminUserDetail(db, userId) });
}

export async function adminUserIdentities(
  request: Request,
  db: D1Database,
  userId: string,
  now: number,
): Promise<Response> {
  if (request.method !== 'POST' && request.method !== 'DELETE') {
    return apiError('method_not_allowed', 405, 'POST, DELETE');
  }
  const input = await readAdminIdentity(request);
  if (request.method === 'POST') {
    const found = await addAdminAccessIdentity(db, { userId, ...input, now });
    if (!found) return apiError('user_not_found', 404);
    return apiData({ user: await getAdminUserDetail(db, userId) }, 201);
  }
  const result = await removeAdminAccessIdentity(db, { userId, ...input });
  if (result === 'not-found') return apiError('identity_not_found', 404);
  if (result === 'last-identity-denied') return apiError('last_active_identity_cannot_be_removed', 409);
  return apiData({ user: await getAdminUserDetail(db, userId) });
}

export async function adminUserGrant(
  request: Request,
  db: D1Database,
  administrator: SystemAdministrator,
  userId: string,
  now: number,
): Promise<Response> {
  if (request.method !== 'PUT' && request.method !== 'DELETE') {
    return apiError('method_not_allowed', 405, 'PUT, DELETE');
  }
  const result = await setAdminGrant(db, {
    userId,
    actorUserId: administrator.userId,
    enabled: request.method === 'PUT',
    now,
  });
  const errors: Record<string, [string, number]> = {
    'not-found': ['user_not_found', 404],
    'inactive-user': ['disabled_user_cannot_be_administrator', 409],
    'self-revoke-denied': ['cannot_revoke_current_administrator', 409],
    'last-admin-denied': ['last_active_administrator_cannot_be_revoked', 409],
  };
  const error = errors[result];
  if (error !== undefined) return apiError(error[0], error[1]);
  return apiData({ user: await getAdminUserDetail(db, userId) });
}
