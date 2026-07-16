export class PermanentOutboundError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PermanentOutboundError';
    this.code = code;
  }
}

export class RetryableOutboundError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RetryableOutboundError';
    this.code = code;
  }
}

export function outboundErrorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
