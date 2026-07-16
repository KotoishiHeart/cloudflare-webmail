import {
  approveRetentionRun,
  cancelRetentionRun,
  createRetentionPreview,
  ensureDefaultRetentionPolicy,
  getRetentionPolicy,
  getRetentionRun,
  getRetentionRunDetail,
  listRetentionRuns,
  saveRetentionPolicy,
  type SystemAdministrator,
} from '@cf-webmail/database';
import { ApiInputError } from './api-input.js';
import { apiData, apiError } from './api-response.js';
import {
  readRetentionApproval,
  readRetentionPolicyPatch,
  readRetentionPreview,
} from './admin-input.js';

export async function adminRetentionPolicy(
  request: Request,
  db: D1Database,
  mailboxId: string,
  now: number,
): Promise<Response> {
  await ensureDefaultRetentionPolicy(db, mailboxId, now);
  const current = await getRetentionPolicy(db, mailboxId);
  if (current === null) return apiError('mailbox_not_found', 404);
  if (request.method === 'GET') return apiData({ policy: current });
  if (request.method !== 'PATCH') return apiError('method_not_allowed', 405, 'GET, PATCH');
  const patch = await readRetentionPolicyPatch(request);
  const policy = await saveRetentionPolicy(db, { ...current, ...patch, mailboxId, now });
  if (policy === null) return apiError('mailbox_not_found', 404);
  return apiData({ policy });
}

export async function adminMailboxRetentionRuns(
  request: Request,
  db: D1Database,
  administrator: SystemAdministrator,
  mailboxId: string,
  now: number,
): Promise<Response> {
  await ensureDefaultRetentionPolicy(db, mailboxId, now);
  if (request.method === 'GET') {
    return apiData({ runs: await listRetentionRuns(db, mailboxId, 50) });
  }
  if (request.method !== 'POST') return apiError('method_not_allowed', 405, 'GET, POST');
  const { limit } = await readRetentionPreview(request);
  const result = await createRetentionPreview(db, {
    mailboxId, userId: administrator.userId, limit, now,
  });
  if (result.status !== 'created') {
    if (result.status === 'not-found') return apiError('mailbox_not_found', 404);
    if (result.status === 'disabled') return apiError('retention_policy_disabled', 409);
    return apiError('retention_run_already_active', 409);
  }
  return apiData({ run: result.run }, 201);
}

export async function adminRetentionRuns(request: Request, db: D1Database): Promise<Response> {
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get('limit') ?? '50';
  if (!/^\d{1,3}$/u.test(rawLimit)) throw new ApiInputError('limit is invalid');
  const limit = Number(rawLimit);
  const mailboxId = url.searchParams.get('mailboxId') ?? undefined;
  return apiData({ runs: await listRetentionRuns(db, mailboxId, limit) });
}

export async function adminRetentionRunResource(
  request: Request,
  db: D1Database,
  runId: string,
): Promise<Response> {
  if (request.method !== 'GET') return apiError('method_not_allowed', 405, 'GET');
  const detail = await getRetentionRunDetail(db, runId);
  return detail === null ? apiError('retention_run_not_found', 404) : apiData(detail);
}

export async function adminApproveRetentionRun(
  request: Request,
  db: D1Database,
  administrator: SystemAdministrator,
  runId: string,
  now: number,
): Promise<Response> {
  if (request.method !== 'POST') return apiError('method_not_allowed', 405, 'POST');
  const evidence = await readRetentionApproval(request);
  const result = await approveRetentionRun(db, {
    runId, userId: administrator.userId, ...evidence, now,
  });
  if (result === 'not-found') return apiError('retention_run_not_found', 404);
  if (result === 'empty-preview') return apiError('empty_retention_preview', 409);
  if (result === 'invalid-state') return apiError('retention_run_not_approvable', 409);
  return apiData({ run: await getRetentionRun(db, runId) });
}

export async function adminCancelRetentionRun(
  request: Request,
  db: D1Database,
  runId: string,
  now: number,
): Promise<Response> {
  if (request.method !== 'POST') return apiError('method_not_allowed', 405, 'POST');
  const result = await cancelRetentionRun(db, runId, now);
  if (result === 'not-found') return apiError('retention_run_not_found', 404);
  if (result === 'invalid-state') return apiError('retention_run_not_cancellable', 409);
  return apiData({ run: await getRetentionRun(db, runId) });
}
