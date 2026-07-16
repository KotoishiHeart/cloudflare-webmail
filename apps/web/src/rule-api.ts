import {
  applyPreviewRuleRun,
  authorizeMailboxAccess,
  createMailboxRule,
  deleteMailboxRule,
  getMailboxRule,
  getMailboxRuleRun,
  listMailboxRuleRunMatches,
  listMailboxRuleRuns,
  listMailboxRules,
  MailRuleRunConflictError,
  previewMailboxRule,
  undoAppliedRuleRun,
  updateMailboxRule,
  type MailRuleDefinition,
} from '@cf-webmail/database';
import type { AccessIdentity } from './access-auth.js';
import { requestIsSameOrigin } from './api-input.js';
import { apiData, apiError } from './api-response.js';
import { readMailRulePatch, type MailRulePatch } from './rule-input.js';

export async function getRules(
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
): Promise<Response> {
  const access = await manageAccess(db, identity, mailboxId);
  if (access instanceof Response) return access;
  return apiData({ rules: await listMailboxRules(db, access.mailboxId) });
}

export async function createRule(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
  now: number,
): Promise<Response> {
  const access = await mutationAccess(request, db, identity, mailboxId);
  if (access instanceof Response) return access;
  const patch = await readMailRulePatch(request, true);
  const rule = await createMailboxRule(db, {
    ...patch as MailRuleDefinition,
    id: crypto.randomUUID(),
    mailboxId: access.mailboxId,
    userId: access.userId,
    now,
  });
  return apiData({ rule }, 201);
}

export async function patchRule(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
  ruleId: string,
  now: number,
): Promise<Response> {
  const access = await mutationAccess(request, db, identity, mailboxId);
  if (access instanceof Response) return access;
  const current = await getMailboxRule(db, access.mailboxId, ruleId);
  if (current === null) return apiError('rule_not_found', 404);
  const definition = mergeDefinition(current, await readMailRulePatch(request, false));
  const rule = await updateMailboxRule(db, {
    ...definition, id: current.id, mailboxId: access.mailboxId, now,
  });
  return rule === null ? apiError('rule_not_found', 404) : apiData({ rule });
}

export async function removeRule(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
  ruleId: string,
): Promise<Response> {
  const access = await mutationAccess(request, db, identity, mailboxId);
  if (access instanceof Response) return access;
  return await deleteMailboxRule(db, access.mailboxId, ruleId)
    ? apiData({ deleted: true })
    : apiError('rule_not_found', 404);
}

export async function previewRule(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
  ruleId: string,
  now: number,
): Promise<Response> {
  const access = await mutationAccess(request, db, identity, mailboxId);
  if (access instanceof Response) return access;
  const rule = await getMailboxRule(db, access.mailboxId, ruleId);
  if (rule === null) return apiError('rule_not_found', 404);
  const run = await previewMailboxRule(db, {
    runId: crypto.randomUUID(), rule, userId: access.userId, now,
  });
  return apiData({ run, matches: await listMailboxRuleRunMatches(db, access.mailboxId, run.id) }, 201);
}

export async function getRuleRuns(
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
): Promise<Response> {
  const access = await manageAccess(db, identity, mailboxId);
  if (access instanceof Response) return access;
  return apiData({ runs: await listMailboxRuleRuns(db, access.mailboxId) });
}

export async function getRuleRun(
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
  runId: string,
): Promise<Response> {
  const access = await manageAccess(db, identity, mailboxId);
  if (access instanceof Response) return access;
  const run = await getMailboxRuleRun(db, access.mailboxId, runId);
  if (run === null) return apiError('rule_run_not_found', 404);
  const matches = await listMailboxRuleRunMatches(db, access.mailboxId, run.id);
  return apiData({ run, matches });
}

export async function applyRuleRun(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
  previewRunId: string,
  now: number,
): Promise<Response> {
  const access = await mutationAccess(request, db, identity, mailboxId);
  if (access instanceof Response) return access;
  return ruleRunMutation(() => applyPreviewRuleRun(db, {
    runId: crypto.randomUUID(), previewRunId, mailboxId: access.mailboxId,
    userId: access.userId, now,
  }));
}

export async function undoRuleRun(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
  sourceRunId: string,
  now: number,
): Promise<Response> {
  const access = await mutationAccess(request, db, identity, mailboxId);
  if (access instanceof Response) return access;
  return ruleRunMutation(() => undoAppliedRuleRun(db, {
    runId: crypto.randomUUID(), sourceRunId, mailboxId: access.mailboxId,
    userId: access.userId, now,
  }));
}

async function ruleRunMutation(operation: () => Promise<unknown>): Promise<Response> {
  try {
    return apiData({ run: await operation() });
  } catch (error) {
    if (error instanceof MailRuleRunConflictError) return apiError(error.code, 409);
    throw error;
  }
}

async function mutationAccess(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  mailboxId: string,
) {
  if (!requestIsSameOrigin(request)) return apiError('cross_origin_request_denied', 403);
  return manageAccess(db, identity, mailboxId);
}

async function manageAccess(db: D1Database, identity: AccessIdentity, mailboxId: string) {
  const access = await authorizeMailboxAccess(db, identity, mailboxId, 'manage');
  return access.allowed ? access : apiError('mailbox_not_found', 404);
}

function mergeDefinition(current: MailRuleDefinition, patch: MailRulePatch): MailRuleDefinition {
  return {
    name: patch.name ?? current.name,
    enabled: patch.enabled ?? current.enabled,
    priority: patch.priority ?? current.priority,
    conditions: { ...current.conditions, ...patch.conditions },
    actions: { ...current.actions, ...patch.actions },
    applyExisting: patch.applyExisting ?? current.applyExisting,
    applyIncoming: patch.applyIncoming ?? current.applyIncoming,
    stopProcessing: patch.stopProcessing ?? current.stopProcessing,
  };
}
