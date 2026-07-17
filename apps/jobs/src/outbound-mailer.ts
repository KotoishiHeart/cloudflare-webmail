export type OutboundMailerAttachment = {
  disposition: 'attachment';
  filename: string;
  type: string;
  content: ArrayBuffer;
};

export type OutboundMailerMessage = {
  deliveryId: string;
  from: { email: string; name: string };
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  attachments?: OutboundMailerAttachment[];
};

export type OutboundMailerResult = {
  messageId: string;
};

export type OutboundMailer = {
  readonly provider: string;
  send(message: OutboundMailerMessage): Promise<OutboundMailerResult>;
};
