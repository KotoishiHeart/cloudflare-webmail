import type { OutboundMailerMessage } from './outbound-mailer.js';
import { createSmtp2goHeaders } from './smtp2go-payload.js';

export type RequestSummary = {
  deliveryId: string;
  requestJsonBytes: number;
  senderDomain: string;
  recipientCounts: { to: number; cc: number; bcc: number };
  recipientDomains: string[];
  subject: { chars: number; bytes: number };
  bodies: { textBytes: number; htmlBytes: number };
  customHeaders: Array<{
    name: string;
    originalValueChars: number;
    valueChars: number;
    valueBytes: number;
    hasControlCharacters: boolean;
    hasLeadingOrTrailingWhitespace: boolean;
    maxLineChars: number;
    angleBracketCount: number;
  }>;
  attachments: { count: number; totalBytes: number; types: string[] };
};

export function summarizeRequest(message: OutboundMailerMessage, requestBody: string): RequestSummary {
  const recipients = [...(message.to ?? []), ...(message.cc ?? []), ...(message.bcc ?? [])];
  const attachments = message.attachments ?? [];
  const providerHeaders = createSmtp2goHeaders(message.headers);
  return {
    deliveryId: message.deliveryId,
    requestJsonBytes: utf8ByteLength(requestBody),
    senderDomain: emailDomain(message.from.email),
    recipientCounts: {
      to: message.to?.length ?? 0,
      cc: message.cc?.length ?? 0,
      bcc: message.bcc?.length ?? 0,
    },
    recipientDomains: [...new Set(recipients.map(emailDomain))].sort(),
    subject: {
      chars: message.subject.length,
      bytes: utf8ByteLength(message.subject),
    },
    bodies: {
      textBytes: utf8ByteLength(message.text),
      htmlBytes: utf8ByteLength(message.html),
    },
    customHeaders: providerHeaders.map(({ header: name, value }) => ({
      name,
      originalValueChars: message.headers[name]?.length ?? value.length,
      valueChars: value.length,
      valueBytes: utf8ByteLength(value),
      hasControlCharacters: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
      hasLeadingOrTrailingWhitespace: value !== value.trim(),
      maxLineChars: maxLineChars(value),
      angleBracketCount: (value.match(/[<>]/gu) ?? []).length,
    })),
    attachments: {
      count: attachments.length,
      totalBytes: attachments.reduce((total, attachment) => total + attachment.content.byteLength, 0),
      types: [...new Set(attachments.map((attachment) => attachment.type))].sort(),
    },
  };
}

export function logSmtp2goFailure(input: {
  kind: 'request_error' | 'response_error' | 'http_error' | 'provider_rejection';
  request: RequestSummary;
  status?: number;
  responseBody?: string;
  error?: Error;
}): void {
  const response = input.responseBody === undefined
    ? undefined
    : providerResponseDiagnostics(input.responseBody);
  console.error(JSON.stringify({
    event: 'smtp2go.send_failed',
    provider: 'smtp2go',
    failureKind: input.kind,
    httpStatus: input.status ?? null,
    request: input.request,
    response: response ?? null,
    error: input.error === undefined
      ? null
      : {
        name: input.error.name,
        message: redactDiagnosticText(input.error.message),
      },
  }));
}

export function providerResponseDiagnostics(body: string): Record<string, unknown> {
  const response = parseResponse(body);
  if (response === null) {
    return {
      bodyBytes: utf8ByteLength(body),
      format: 'non_json',
      preview: redactDiagnosticText(body).slice(0, 1000),
    };
  }

  const data = isRecord(response.data) ? response.data : response;
  const fieldErrors = normalizedFieldValidationErrors(
    data.field_validation_errors ?? response.field_validation_errors,
  );
  const diagnostics: Record<string, unknown> = {
    bodyBytes: utf8ByteLength(body),
    format: 'json',
    responseKeys: Object.keys(response).sort(),
    dataKeys: Object.keys(data).sort(),
  };
  for (const [key, value] of [
    ['errorCode', data.error_code ?? response.error_code],
    ['error', data.error ?? response.error],
    ['message', data.message ?? response.message],
  ] as const) {
    if (typeof value === 'string' && value.trim() !== '') {
      diagnostics[key] = redactDiagnosticText(value);
    }
  }
  if (fieldErrors.length > 0) {
    diagnostics.fieldValidationErrors = fieldErrors.map(({ field, message }) => ({
      field,
      message: redactDiagnosticText(message),
    }));
  }
  if (Array.isArray(data.failures)) {
    diagnostics.failureCount = data.failures.length;
    diagnostics.failures = data.failures.slice(0, 10).map((failure) => (
      typeof failure === 'string'
        ? redactDiagnosticText(failure)
        : isRecord(failure)
          ? Object.fromEntries(
            Object.entries(failure)
              .filter(([key]) => ['error', 'message', 'error_code'].includes(key))
              .map(([key, value]) => [
                key,
                typeof value === 'string' ? redactDiagnosticText(value) : typeof value,
              ]),
          )
          : typeof failure
    ));
  }
  return diagnostics;
}

export function normalizedFieldValidationErrors(value: unknown): Array<{ field: string; message: string }> {
  if (!isRecord(value)) return [];
  if (typeof value.fieldname === 'string' || typeof value.message === 'string') {
    const field = typeof value.fieldname === 'string' && value.fieldname.trim() !== ''
      ? value.fieldname.trim()
      : 'unknown';
    const message = typeof value.message === 'string' ? value.message.trim() : '';
    return message === '' ? [] : [{ field, message }];
  }

  const errors: Array<{ field: string; message: string }> = [];
  for (const [field, fieldError] of Object.entries(value)) {
    const detail = isRecord(fieldError)
      ? fieldError.message ?? fieldError.error ?? fieldError.error_code
      : fieldError;
    if (typeof detail === 'string' && detail.trim() !== '') {
      errors.push({ field, message: detail.trim() });
    }
  }
  return errors;
}

function parseResponse(body: string): Record<string, unknown> | null {
  if (body.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function redactDiagnosticText(value: string): string {
  return cleanMessage(value).replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    '[redacted-email]',
  );
}

function emailDomain(value: string): string {
  const at = value.lastIndexOf('@');
  return at > 0 && at < value.length - 1 ? value.slice(at + 1).toLowerCase() : '[invalid]';
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function maxLineChars(value: string): number {
  return Math.max(...value.split(/\r\n|\r|\n/u).map((line) => line.length), 0);
}

function cleanMessage(value: string): string {
  return value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
