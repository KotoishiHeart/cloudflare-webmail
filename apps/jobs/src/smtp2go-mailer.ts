import { PermanentOutboundError, RetryableOutboundError } from './outbound-errors.js';
import type { OutboundMailer } from './outbound-mailer.js';
import {
  logSmtp2goFailure,
  normalizedFieldValidationErrors,
  summarizeRequest,
} from './smtp2go-diagnostics.js';
import { createSmtp2goPayload } from './smtp2go-payload.js';
const SMTP2GO_SEND_URL = 'https://api.smtp2go.com/v3/email/send';
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const PROVIDER_TIMEOUT_MILLISECONDS = 30 * 1000;
const PROVIDER = 'smtp2go';

export function createSmtp2goMailer(
  apiKeyInput: string,
  fetcher: typeof fetch = fetch,
): OutboundMailer {
  const apiKey = requireApiKey(apiKeyInput);
  return {
    provider: PROVIDER,
    async send(message) {
      const requestBody = JSON.stringify(createSmtp2goPayload(message));
      const requestSummary = summarizeRequest(message, requestBody);
      let response: Response;
      try {
        response = await fetcher(SMTP2GO_SEND_URL, {
          method: 'POST',
          // Workers does not implement redirect: 'error'. Manual mode also prevents
          // the API key header from being forwarded to a redirect destination.
          redirect: 'manual',
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MILLISECONDS),
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-smtp2go-api-key': apiKey,
          },
          body: requestBody,
        });
      } catch (error) {
        logSmtp2goFailure({
          kind: 'request_error',
          request: requestSummary,
          ...(error instanceof Error ? { error } : {}),
        });
        throw new RetryableOutboundError(
          'smtp2go_network_error',
          'SMTP2GO API request failed before a response was received',
        );
      }
      let body: string;
      try {
        body = await readBoundedResponse(response);
      } catch (error) {
        logSmtp2goFailure({
          kind: 'response_error',
          request: requestSummary,
          status: response.status,
          ...(error instanceof Error ? { error } : {}),
        });
        throw error;
      }
      if (!response.ok) {
        logSmtp2goFailure({
          kind: 'http_error',
          request: requestSummary,
          status: response.status,
          responseBody: body,
        });
        throw responseError(response.status, body);
      }
      const parsed = parseResponse(body);
      const rejection = explicitRejection(parsed);
      if (rejection !== null) {
        logSmtp2goFailure({
          kind: 'provider_rejection',
          request: requestSummary,
          status: response.status,
          responseBody: body,
        });
        throw new PermanentOutboundError('smtp2go_rejected', rejection);
      }
      return {
        messageId: providerMessageId(parsed) ?? `smtp2go-accepted:${message.deliveryId}`,
      };
    },
  };
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new RetryableOutboundError(
      'smtp2go_response_too_large',
      'SMTP2GO API response exceeded the safety limit',
    );
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel('provider response exceeded the safety limit');
      throw new RetryableOutboundError(
        'smtp2go_response_too_large',
        'SMTP2GO API response exceeded the safety limit',
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function responseError(status: number, body: string): PermanentOutboundError | RetryableOutboundError {
  const detail = providerErrorMessage(body);
  if (status >= 300 && status < 400) {
    return new RetryableOutboundError(
      'smtp2go_redirected',
      'SMTP2GO returned an unexpected redirect',
    );
  }
  if (status === 429) {
    return new RetryableOutboundError('smtp2go_rate_limited', detail ?? 'SMTP2GO rate limit exceeded');
  }
  if (status === 408 || status >= 500) {
    return new RetryableOutboundError('smtp2go_unavailable', detail ?? `SMTP2GO returned HTTP ${status}`);
  }
  if (status === 401) {
    return new PermanentOutboundError('smtp2go_authentication_failed', 'SMTP2GO rejected the API key');
  }
  if (status === 403) {
    return new PermanentOutboundError('smtp2go_permission_denied', 'SMTP2GO API key lacks send permission');
  }
  if (status >= 400 && status < 500) {
    return new PermanentOutboundError('smtp2go_rejected', detail ?? `SMTP2GO returned HTTP ${status}`);
  }
  return new RetryableOutboundError('smtp2go_unexpected_status', `SMTP2GO returned HTTP ${status}`);
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

function explicitRejection(response: Record<string, unknown> | null): string | null {
  if (response === null) return null;
  const data = isRecord(response.data) ? response.data : response;
  const failures = Array.isArray(data.failures) ? data.failures : [];
  const failed = typeof data.failed === 'number' ? data.failed : 0;
  const succeeded = typeof data.succeeded === 'number' ? data.succeeded : 1;
  const hasProviderError = [
    response.error,
    response.message,
    response.error_code,
    data.error,
    data.message,
    data.error_code,
  ].some((value) => value !== undefined) || normalizedFieldValidationErrors(
    data.field_validation_errors ?? response.field_validation_errors,
  ).length > 0;
  if (failed < 1 && succeeded !== 0 && failures.length === 0 && !hasProviderError) {
    return null;
  }
  return providerErrorMessage(JSON.stringify(response)) ?? 'SMTP2GO rejected the message';
}

function providerMessageId(response: Record<string, unknown> | null): string | null {
  if (response === null) return null;
  const data = isRecord(response.data) ? response.data : null;
  for (const candidate of [data?.email_id, data?.emailId, response.request_id, response.requestId]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().slice(0, 512);
  }
  return null;
}

function providerErrorMessage(body: string): string | null {
  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value)) return null;
    const data = isRecord(value.data) ? value.data : null;

    const fieldErrors = normalizedFieldValidationErrors(
      data?.field_validation_errors ?? value.field_validation_errors,
    );
    const nestedCode = typeof data?.error_code === 'string' ? data.error_code.trim() : '';
    if (fieldErrors.length > 0) {
      const detail = fieldErrors
        .map(({ field, message }) => `${field}: ${message}`)
        .join('; ');
      return cleanMessage(nestedCode === '' ? detail : `${nestedCode}: ${detail}`);
    }

    // SMTP2GO puts HTTP 400 details under data.error_code and data.error.
    // Include both values so the delivery record explains the provider rejection.
    const nestedError = typeof data?.error === 'string' ? data.error.trim() : '';
    if (nestedError !== '') {
      return cleanMessage(nestedCode === '' ? nestedError : `${nestedCode}: ${nestedError}`);
    }
    if (nestedCode !== '') return cleanMessage(nestedCode);

    for (const candidate of [value.error, value.message, value.error_code]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        return cleanMessage(candidate);
      }
    }
    const failures = Array.isArray(data?.failures) ? data.failures : [];
    const first = failures[0];
    if (typeof first === 'string' && first.trim() !== '') return cleanMessage(first);
    if (isRecord(first)) {
      const detail = first.error ?? first.message ?? first.error_code;
      if (typeof detail === 'string' && detail.trim() !== '') return cleanMessage(detail);
    }
  } catch {
    return null;
  }
  return null;
}

function cleanMessage(value: string): string {
  return value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 500);
}

function requireApiKey(input: string): string {
  const value = input.trim();
  if (value.length < 16 || value.length > 256 || /\s|[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PermanentOutboundError(
      'smtp2go_configuration_error',
      'SMTP2GO_API_KEY is missing or invalid',
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
