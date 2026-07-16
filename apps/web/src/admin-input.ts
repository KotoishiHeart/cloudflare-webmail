import type { MailboxRole } from '@cf-webmail/database';
import { ApiInputError, isRecord, readBoundedJson } from './api-input.js';

const MAX_ADMIN_BODY_BYTES = 16 * 1024;

export type CreateAdminUserInput = {
  email: string;
  displayName?: string;
  identity: { issuer: string; subject: string; email?: string };
  isSystemAdmin: boolean;
};

export async function readCreateAdminUser(request: Request): Promise<CreateAdminUserInput> {
  const input = await adminObject(request, ['email', 'displayName', 'identity', 'isSystemAdmin']);
  if (!isRecord(input.identity)) throw new ApiInputError('identity must be an object');
  exactKeys(input.identity, ['issuer', 'subject', 'email']);
  return {
    email: requiredString(input.email, 'email'),
    ...optionalStringField(input, 'displayName'),
    identity: {
      issuer: requiredString(input.identity.issuer, 'identity.issuer'),
      subject: requiredString(input.identity.subject, 'identity.subject'),
      ...optionalStringField(input.identity, 'email'),
    },
    isSystemAdmin: optionalBoolean(input.isSystemAdmin, 'isSystemAdmin') ?? false,
  };
}

export async function readAdminUserPatch(request: Request) {
  const input = await adminObject(request, ['email', 'displayName', 'status']);
  if (Object.keys(input).length === 0) throw new ApiInputError('user patch is empty');
  return {
    ...optionalStringField(input, 'email'),
    ...(input.displayName === null ? { displayName: null } : optionalStringField(input, 'displayName')),
    ...optionalStatusField(input),
  };
}

export async function readAdminIdentity(request: Request) {
  const input = await adminObject(request, ['issuer', 'subject', 'email']);
  return {
    issuer: requiredString(input.issuer, 'issuer'),
    subject: requiredString(input.subject, 'subject'),
    email: requiredString(input.email, 'email'),
  };
}

export async function readCreateAdminMailbox(request: Request) {
  const input = await adminObject(request, ['address', 'displayName', 'ownerUserId']);
  return {
    address: requiredString(input.address, 'address'),
    ...optionalStringField(input, 'displayName'),
    ownerUserId: requiredString(input.ownerUserId, 'ownerUserId'),
  };
}

export async function readAdminMailboxPatch(request: Request) {
  const input = await adminObject(request, ['displayName', 'status']);
  if (Object.keys(input).length === 0) throw new ApiInputError('mailbox patch is empty');
  return { ...optionalStringField(input, 'displayName'), ...optionalStatusField(input) };
}

export async function readAdminAddress(request: Request) {
  const input = await adminObject(request, ['address', 'kind', 'status']);
  const kind = input.kind === undefined ? undefined : requiredString(input.kind, 'kind');
  if (kind !== undefined && kind !== 'primary' && kind !== 'alias') {
    throw new ApiInputError('kind must be primary or alias');
  }
  return {
    address: requiredString(input.address, 'address'),
    ...(kind === undefined ? {} : { kind }),
    ...optionalStatusField(input),
  } as {
    address: string;
    kind?: 'primary' | 'alias';
    status?: 'active' | 'disabled';
  };
}

export async function readAdminMembership(request: Request): Promise<{ role: MailboxRole }> {
  const input = await adminObject(request, ['role']);
  const role = requiredString(input.role, 'role');
  if (role !== 'viewer' && role !== 'operator' && role !== 'owner') {
    throw new ApiInputError('role must be viewer, operator, or owner');
  }
  return { role };
}

export async function readRetentionPolicyPatch(request: Request) {
  const input = await adminObject(request, [
    'retentionDays', 'excludeStarred', 'excludeLabeled', 'enabled',
  ]);
  if (Object.keys(input).length === 0) throw new ApiInputError('retention policy patch is empty');
  const retentionDays = input.retentionDays;
  if (retentionDays !== undefined && (
    !Number.isSafeInteger(retentionDays) || Number(retentionDays) < 1 || Number(retentionDays) > 3650
  )) {
    throw new ApiInputError('retentionDays must be between 1 and 3650');
  }
  return {
    ...(retentionDays === undefined ? {} : { retentionDays: Number(retentionDays) }),
    ...optionalBooleanField(input, 'excludeStarred'),
    ...optionalBooleanField(input, 'excludeLabeled'),
    ...optionalBooleanField(input, 'enabled'),
  };
}

export async function readRetentionPreview(request: Request): Promise<{ limit: number }> {
  const input = await adminObject(request, ['limit']);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 200) {
    throw new ApiInputError('limit must be between 1 and 200');
  }
  return { limit: Number(limit) };
}

export async function readRetentionApproval(request: Request) {
  const input = await adminObject(request, [
    'backupReference', 'backupManifestSha256', 'backupCreatedAt', 'confirmation',
  ]);
  if (input.confirmation !== 'BACKUP_VERIFIED') {
    throw new ApiInputError('confirmation must be BACKUP_VERIFIED');
  }
  if (!Number.isSafeInteger(input.backupCreatedAt) || Number(input.backupCreatedAt) <= 0) {
    throw new ApiInputError('backupCreatedAt must be a positive timestamp');
  }
  return {
    backupReference: requiredString(input.backupReference, 'backupReference'),
    backupManifestSha256: requiredString(
      input.backupManifestSha256, 'backupManifestSha256',
    ),
    backupCreatedAt: Number(input.backupCreatedAt),
  };
}

async function adminObject(request: Request, allowed: string[]): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new ApiInputError('JSON content type is required');
  const input = await readBoundedJson(request, MAX_ADMIN_BODY_BYTES);
  if (!isRecord(input)) throw new ApiInputError('request body must be an object');
  exactKeys(input, allowed);
  return input;
}

function exactKeys(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new ApiInputError('request contains an unknown field');
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiInputError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalStringField(
  input: Record<string, unknown>,
  field: string,
): Record<string, string> {
  const value = input[field];
  if (value === undefined) return {};
  return { [field]: requiredString(value, field) };
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ApiInputError(`${field} must be boolean`);
  return value;
}

function optionalBooleanField(
  input: Record<string, unknown>,
  field: string,
): Record<string, boolean> {
  const value = optionalBoolean(input[field], field);
  return value === undefined ? {} : { [field]: value };
}

function optionalStatusField(input: Record<string, unknown>) {
  if (input.status === undefined) return {};
  if (input.status !== 'active' && input.status !== 'disabled') {
    throw new ApiInputError('status must be active or disabled');
  }
  return { status: input.status } as const;
}
