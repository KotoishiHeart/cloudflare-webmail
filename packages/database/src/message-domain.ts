export type MessageStatus = 'ready' | 'quarantined';
export type AttachmentDisposition = 'attachment' | 'inline' | 'unspecified';

export type InboundAttachmentRecord = {
  ordinal: number;
  filename: string;
  contentType: string;
  disposition: AttachmentDisposition;
  contentId: string;
  size: number;
  sha256: string;
  storageKey: string;
  createdAt: number;
};

export type InboundMessageRecord = {
  id: string;
  mailboxId: string;
  status: MessageStatus;
  processingError: string;
  envelopeFrom: string;
  deliveredTo: string;
  rfcMessageId: string;
  inReplyTo: string;
  referencesHeader: string;
  subject: string;
  sender: string;
  recipients: string;
  cc: string;
  replyTo: string;
  dateHeader: string;
  receivedAt: number;
  textPreview: string;
  rawKey: string;
  rawSha256: string;
  rawEtag: string;
  rawSize: number;
  bodyTextKey: string | null;
  bodyHtmlKey: string | null;
  attachments: InboundAttachmentRecord[];
  createdAt: number;
};

export type StoredInboundMessage = {
  id: string;
  mailboxId: string;
  rawKey: string;
  rawSha256: string;
  status: MessageStatus;
};

export type PersistInboundResult = {
  message: StoredInboundMessage;
  created: boolean;
  duplicateBy: 'id' | 'content' | null;
};
