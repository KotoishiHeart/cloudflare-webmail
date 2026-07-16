const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const CONTROL_OR_SPACE_PATTERN = /[\s\u0000-\u001f\u007f]/u;

export class DatabaseInputError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'DatabaseInputError';
    this.field = field;
  }
}

export function normalizeEmailAddress(value: string, field = 'email'): string {
  const address = value.trim();
  const at = address.indexOf('@');

  if (
    address.length < 3
    || address.length > 320
    || at <= 0
    || at !== address.lastIndexOf('@')
    || at === address.length - 1
    || CONTROL_OR_SPACE_PATTERN.test(address)
  ) {
    throw new DatabaseInputError(field, 'must be a valid mailbox address');
  }

  const localPart = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (localPart.length > 64 || domain.length > 255) {
    throw new DatabaseInputError(field, 'exceeds mailbox address limits');
  }

  return `${localPart.toLowerCase()}@${domain.toLowerCase()}`;
}

export function normalizeId(value: string, field: string): string {
  const id = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) {
    throw new DatabaseInputError(field, 'must be a UUID');
  }
  return id;
}

export function normalizeIssuer(value: string, field = 'identity.issuer'): string {
  const issuer = value.trim();
  if (issuer.length === 0 || issuer.length > 2048) {
    throw new DatabaseInputError(field, 'must be between 1 and 2048 characters');
  }

  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new DatabaseInputError(field, 'must be an absolute HTTPS URL');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new DatabaseInputError(field, 'must be an absolute HTTPS URL without credentials or query data');
  }

  return parsed.href.endsWith('/') ? parsed.href.slice(0, -1) : parsed.href;
}

export function normalizeSubject(value: string, field = 'identity.subject'): string {
  return normalizeBoundedText(value, field, 512);
}

export function normalizeDisplayName(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  return normalizeBoundedText(value, 'displayName', 160);
}

export function requireTimestamp(value: number, field = 'now'): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DatabaseInputError(field, 'must be a positive millisecond timestamp');
  }
  return value;
}

function normalizeBoundedText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength || CONTROL_PATTERN.test(normalized)) {
    throw new DatabaseInputError(field, `must be between 1 and ${maxLength} visible characters`);
  }
  return normalized;
}
