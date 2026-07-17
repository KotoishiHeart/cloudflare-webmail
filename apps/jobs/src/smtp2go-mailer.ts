import { PermanentOutboundError, RetryableOutboundError } from './outbound-errors.js';
import type {
  OutboundMailer,
  OutboundMailerAttachment,
  OutboundMailerMessage,
} from './outbound-mailer.js';

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
      let response: Response;
      try {
        response = await fetcher(SMTP2GO_SEND_URL, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MILLISECONDS),
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-smtp2go-api-key': apiKey,
          },
          body: JSON.stringify(payload(message)),
        });
      } catch {
        throw new RetryableOutboundError(
          'smtp2go_network_error',
          'SMTP2GO API request failed before a response was received',
        );
      }
      const body = await readBoundedResponse(response);
      if (!response.ok) throw responseError(response.status, body);
      const parsed = parseResponse(body);
      const rejection = explicitRejection(parsed);
      if (rejection !== null) {
        throw new PermanentOutboundError('smtp2go_rejected', rejection);
      }
      return {
        messageId: providerMessageId(parsed) ?? `smtp2go-accepted:${message.deliveryId}`,
      };
    },
  };
}

function payload(message: OutboundMailerMessage): Record<string, unknown> {
  return {
    sender: sender(message.from),
    ...(message.to === undefined ? {} : { to: message.to }),
    ...(message.cc === undefined ? {} : { cc: message.cc }),
    ...(message.bcc === undefined ? {} : { bcc: message.bcc }),
    subject: message.subject,
    text_body: message.text,
    html_body: message.html,
    custom_headers: Object.entries(message.headers).map(([header, value]) => ({ header, value })),
    ...(message.attachments === undefined
      ? {}
      : { attachments: message.attachments.map(providerAttachment) }),
  };
}

function sender(from: OutboundMailerMessage['from']): string {
  if (from.name === '') return from.email;
  return `"${from.name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" <${from.email}>`;
}

function providerAttachment(attachment: OutboundMailerAttachment): Record<string, string> {
  return {
    filename: attachment.filename,
    mimetype: attachment.type,
    fileblob: arrayBufferToBase64(attachment.content),
  };
}

function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
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
  if (failed < 1 && succeeded !== 0 && failures.length === 0 && response.error === undefined) {
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
    for (const candidate of [value.error, value.message, value.error_code]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        return cleanMessage(candidate);
      }
    }
    const data = isRecord(value.data) ? value.data : null;
    const failures = Array.isArray(data?.failures) ? data.failures : [];
    const first = failures[0];
    if (typeof first === 'string' && first.trim() !== '') return cleanMessage(first);
    if (isRecord(first)) {
      const detail = first.error ?? first.message;
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
