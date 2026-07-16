import type { MailboxRole } from './domain.js';

export const WEB_MAILBOX_FOLDERS = [
  'inbox',
  'outbox',
  'sent',
  'starred',
  'archive',
  'trash',
  'all',
] as const;

export type WebMailboxFolder = (typeof WEB_MAILBOX_FOLDERS)[number];

export type WebMessageSummary = {
  id: string;
  mailboxId: string;
  direction: 'inbound' | 'outbound';
  status: 'ready' | 'quarantined' | 'draft' | 'queued' | 'sending' | 'sent' | 'failed';
  subject: string;
  sender: string;
  recipients: string;
  receivedAt: number;
  textPreview: string;
  rawSize: number;
  attachmentCount: number;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  isDeleted: boolean;
};

export type WebMessageDetail = WebMessageSummary & {
  role: MailboxRole;
  processingError: string;
  envelopeFrom: string;
  deliveredTo: string;
  rfcMessageId: string;
  inReplyTo: string;
  referencesHeader: string;
  cc: string;
  replyTo: string;
  dateHeader: string;
  rawKey: string;
  bodyTextKey: string | null;
  bodyHtmlKey: string | null;
};

export type WebAttachment = {
  ordinal: number;
  filename: string;
  contentType: string;
  disposition: 'attachment' | 'inline' | 'unspecified';
  contentId: string;
  size: number;
  sha256: string;
  storageKey: string;
};

export type WebMessageCursor = {
  before: number;
  beforeId: string;
};

export const WEB_MESSAGE_QUICK_FILTERS = [
  'all',
  'unread',
  'read',
  'starred',
  'attachments',
  'large',
  'html',
  'bodyless',
  'today',
  'last7d',
] as const;

export type WebMessageQuickFilter = (typeof WEB_MESSAGE_QUICK_FILTERS)[number];

export type WebMessageSearchFilters = {
  query: string;
  from: string;
  to: string;
  domain: string;
  dateFrom: number | null;
  dateToExclusive: number | null;
  attachment: 'any' | 'with' | 'without';
  read: 'any' | 'read' | 'unread';
  starred: 'any' | 'starred' | 'unstarred';
  minimumBytes: number | null;
  maximumBytes: number | null;
  quickFilter: WebMessageQuickFilter;
  labelId: string;
  todayStart: number;
  sevenDaysAgo: number;
};

export type WebMessageListQuery = {
  folder: WebMailboxFolder;
  limit: number;
  cursor: WebMessageCursor | null;
  filters: WebMessageSearchFilters;
};

export type WebMessagePage = {
  messages: WebMessageSummary[];
  nextCursor: WebMessageCursor | null;
};

export type WebMessageFlagPatch = Partial<Pick<
  WebMessageSummary,
  'isRead' | 'isStarred' | 'isArchived' | 'isDeleted'
>>;
