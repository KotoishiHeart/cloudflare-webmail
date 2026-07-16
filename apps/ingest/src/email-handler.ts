export const INGEST_NOT_READY_REASON = 'Mailbox ingestion is not enabled yet';

export type RejectableEmail = Pick<ForwardableEmailMessage, 'setReject'>;

export function rejectUnconfiguredInbound(message: RejectableEmail): string {
  message.setReject(INGEST_NOT_READY_REASON);
  return INGEST_NOT_READY_REASON;
}
