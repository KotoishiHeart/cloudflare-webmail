export const MAILBOX_ROLES = ['viewer', 'operator', 'owner'] as const;
export const MAILBOX_CAPABILITIES = ['read', 'operate', 'manage'] as const;

export type MailboxRole = (typeof MAILBOX_ROLES)[number];
export type MailboxCapability = (typeof MAILBOX_CAPABILITIES)[number];
export type RecordStatus = 'active' | 'disabled';
export type MailboxAddressKind = 'primary' | 'alias';

const ROLE_LEVEL: Record<MailboxRole, number> = {
  viewer: 1,
  operator: 2,
  owner: 3,
};

const CAPABILITY_LEVEL: Record<MailboxCapability, number> = {
  read: 1,
  operate: 2,
  manage: 3,
};

export type AccessIdentityKey = {
  issuer: string;
  subject: string;
};

export type MailboxRoute = {
  mailboxId: string;
  address: string;
  addressKind: MailboxAddressKind;
  primaryAddress: string;
  displayName: string;
};

export type AuthorizedMailbox = MailboxRoute & {
  userId: string;
  role: MailboxRole;
};

export type MailboxAccessDenialReason =
  | 'identity-not-linked'
  | 'user-disabled'
  | 'mailbox-not-found'
  | 'mailbox-disabled'
  | 'not-a-member'
  | 'insufficient-role';

export type MailboxAccessDecision =
  | {
    allowed: true;
    userId: string;
    mailboxId: string;
    role: MailboxRole;
  }
  | {
    allowed: false;
    reason: MailboxAccessDenialReason;
  };

export function isMailboxRole(value: unknown): value is MailboxRole {
  return typeof value === 'string' && MAILBOX_ROLES.some((role) => role === value);
}

export function isMailboxAddressKind(value: unknown): value is MailboxAddressKind {
  return value === 'primary' || value === 'alias';
}

export function mailboxRoleGrants(
  role: MailboxRole,
  capability: MailboxCapability,
): boolean {
  return ROLE_LEVEL[role] >= CAPABILITY_LEVEL[capability];
}
