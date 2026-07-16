export class PermanentInboundError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PermanentInboundError';
    this.code = code;
  }
}

export function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
