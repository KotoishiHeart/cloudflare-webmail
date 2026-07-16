import type { AccessIdentityKey, MailboxRole } from './domain.js';

export type OutboundDeliveryStatus = 'queued' | 'sending' | 'sent' | 'failed';
export type OutboundRecipientKind = 'to' | 'cc' | 'bcc';
export type OutboundComposeMode = 'new' | 'reply' | 'forward';

export type OutboundComposeContext = {
  userId: string;
  mailboxId: string;
  role: MailboxRole;
  address: string;
  displayName: string;
};

export type OutboundRecipient = {
  kind: OutboundRecipientKind;
  ordinal: number;
  address: string;
};

export type OutboundMessageRecord = {
  id: string;
  mailboxId: string;
  requestedByUserId: string;
  idempotencyKey: string;
  sender: string;
  senderAddress: string;
  recipients: OutboundRecipient[];
  subject: string;
  textPreview: string;
  rawKey: string;
  rawSha256: string;
  rawEtag: string;
  rawSize: number;
  bodyTextKey: string;
  bodyHtmlKey: string;
  archiveMessageId: string;
  composeMode: OutboundComposeMode;
  sourceMessageId: string | null;
  inReplyTo: string;
  referencesHeader: string;
  createdAt: number;
};

export type OutboundThreadContext = Pick<
  OutboundMessageRecord,
  'composeMode' | 'sourceMessageId' | 'inReplyTo' | 'referencesHeader'
>;

export type StoredOutboundRequest = {
  messageId: string;
  mailboxId: string;
  status: OutboundDeliveryStatus;
  idempotencyKey: string;
  providerMessageId: string;
  createdAt: number;
};

export type PersistOutboundResult = {
  request: StoredOutboundRequest;
  created: boolean;
};

export type OutboundDeliveryMessage = StoredOutboundRequest & {
  senderAddress: string;
  senderName: string;
  subject: string;
  bodyTextKey: string;
  bodyHtmlKey: string;
  inReplyTo: string;
  referencesHeader: string;
  to: string[];
  cc: string[];
  bcc: string[];
  attemptCount: number;
  nextAttemptAt: number;
  leaseExpiresAt: number;
  leaseToken: string;
};

export type RecoverableOutboundMessage = {
  messageId: string;
  mailboxId: string;
};

export type OutboundIdentity = AccessIdentityKey;
