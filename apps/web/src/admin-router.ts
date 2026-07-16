import { getSystemAdministrator } from '@cf-webmail/database';
import type { AccessIdentity } from './access-auth.js';
import { requestIsSameOrigin } from './api-input.js';
import { apiError } from './api-response.js';
import { adminAuditEvents, adminDeliveryEvents, adminSummary } from './admin-events-api.js';
import {
  adminMailboxAddresses,
  adminMailboxMember,
  adminMailboxResource,
  adminMailboxesCollection,
} from './admin-mailboxes-api.js';
import {
  adminUserGrant,
  adminUserIdentities,
  adminUserResource,
  adminUsersCollection,
} from './admin-users-api.js';
import {
  adminApproveRetentionRun,
  adminCancelRetentionRun,
  adminMailboxRetentionRuns,
  adminRetentionPolicy,
  adminRetentionRunResource,
  adminRetentionRuns,
} from './admin-retention-api.js';

export async function routeAdminApi(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  now: number,
): Promise<Response> {
  const administrator = await getSystemAdministrator(db, identity);
  if (administrator === null) return apiError('administrator_required', 403);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !requestIsSameOrigin(request)) {
    return apiError('cross_origin_request_denied', 403);
  }
  try {
    return await routeAuthorizedAdminApi(request, db, administrator, now);
  } catch (error) {
    if (isUniqueConstraintError(error)) return apiError('resource_conflict', 409);
    throw error;
  }
}

async function routeAuthorizedAdminApi(
  request: Request,
  db: D1Database,
  administrator: NonNullable<Awaited<ReturnType<typeof getSystemAdministrator>>>,
  now: number,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/api/admin/summary') {
    return request.method === 'GET'
      ? adminSummary(db, now)
      : apiError('method_not_allowed', 405, 'GET');
  }
  if (pathname === '/api/admin/audit-events') {
    return request.method === 'GET'
      ? adminAuditEvents(request, db)
      : apiError('method_not_allowed', 405, 'GET');
  }
  if (pathname === '/api/admin/delivery-events') {
    return request.method === 'GET'
      ? adminDeliveryEvents(request, db)
      : apiError('method_not_allowed', 405, 'GET');
  }
  if (pathname === '/api/admin/retention-runs') {
    return request.method === 'GET'
      ? adminRetentionRuns(request, db)
      : apiError('method_not_allowed', 405, 'GET');
  }
  const retentionAction = pathname.match(
    /^\/api\/admin\/retention-runs\/([^/]+)\/(approve|cancel)$/u,
  );
  if (retentionAction !== null) {
    return retentionAction[2] === 'approve'
      ? adminApproveRetentionRun(
        request, db, administrator, retentionAction[1] ?? '', now,
      )
      : adminCancelRetentionRun(request, db, retentionAction[1] ?? '', now);
  }
  const retentionRun = pathname.match(/^\/api\/admin\/retention-runs\/([^/]+)$/u);
  if (retentionRun !== null) {
    return adminRetentionRunResource(request, db, retentionRun[1] ?? '');
  }
  if (pathname === '/api/admin/users') {
    return adminUsersCollection(request, db, administrator, now);
  }
  const userIdentities = pathname.match(/^\/api\/admin\/users\/([^/]+)\/identities$/u);
  if (userIdentities !== null) {
    return adminUserIdentities(request, db, userIdentities[1] ?? '', now);
  }
  const userGrant = pathname.match(/^\/api\/admin\/users\/([^/]+)\/administrator$/u);
  if (userGrant !== null) {
    return adminUserGrant(request, db, administrator, userGrant[1] ?? '', now);
  }
  const user = pathname.match(/^\/api\/admin\/users\/([^/]+)$/u);
  if (user !== null) return adminUserResource(request, db, administrator, user[1] ?? '', now);

  if (pathname === '/api/admin/mailboxes') return adminMailboxesCollection(request, db, now);
  const retentionPolicy = pathname.match(
    /^\/api\/admin\/mailboxes\/([^/]+)\/retention-policy$/u,
  );
  if (retentionPolicy !== null) {
    return adminRetentionPolicy(request, db, retentionPolicy[1] ?? '', now);
  }
  const mailboxRetentionRuns = pathname.match(
    /^\/api\/admin\/mailboxes\/([^/]+)\/retention-runs$/u,
  );
  if (mailboxRetentionRuns !== null) {
    return adminMailboxRetentionRuns(
      request, db, administrator, mailboxRetentionRuns[1] ?? '', now,
    );
  }
  const addresses = pathname.match(/^\/api\/admin\/mailboxes\/([^/]+)\/addresses$/u);
  if (addresses !== null) {
    return adminMailboxAddresses(request, db, addresses[1] ?? '', now);
  }
  const member = pathname.match(
    /^\/api\/admin\/mailboxes\/([^/]+)\/members\/([^/]+)$/u,
  );
  if (member !== null) {
    return adminMailboxMember(
      request, db, member[1] ?? '', member[2] ?? '', now,
    );
  }
  const mailbox = pathname.match(/^\/api\/admin\/mailboxes\/([^/]+)$/u);
  if (mailbox !== null) return adminMailboxResource(request, db, mailbox[1] ?? '', now);
  return apiError('not_found', 404);
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error
    && /(?:UNIQUE constraint failed|constraint failed: UNIQUE)/iu.test(error.message);
}
