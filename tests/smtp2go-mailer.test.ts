import { describe, expect, it, vi } from 'vitest';
import {
  PermanentOutboundError,
  RetryableOutboundError,
} from '../apps/jobs/src/outbound-errors.js';
import type { OutboundMailerMessage } from '../apps/jobs/src/outbound-mailer.js';
import { createSmtp2goMailer } from '../apps/jobs/src/smtp2go-mailer.js';

const API_KEY = `api-${'a'.repeat(32)}`;

describe('SMTP2GO outbound adapter', () => {
  it('sends the provider payload with header-only authentication', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      request_id: 'request-123',
      data: { succeeded: 1, failed: 0, failures: [], email_id: 'email-456' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const mailer = createSmtp2goMailer(API_KEY, fetcher as typeof fetch);

    await expect(mailer.send(message())).resolves.toEqual({ messageId: 'email-456' });
    expect(mailer.provider).toBe('smtp2go');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://api.smtp2go.com/v3/email/send');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('x-smtp2go-api-key')).toBe(API_KEY);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      sender: '"Sender Name" <sender@example.com>',
      to: ['recipient@example.net'],
      cc: ['copy@example.net'],
      bcc: ['hidden@example.net'],
      subject: 'Provider test',
      text_body: 'plain body',
      html_body: '<p>html body</p>',
      custom_headers: [
        { header: 'X-CF-Webmail-Delivery-ID', value: 'delivery-123' },
      ],
      attachments: [{
        filename: 'data.bin',
        mimetype: 'application/octet-stream',
        fileblob: 'AAH+/w==',
      }],
    });
    expect(body).not.toHaveProperty('api_key');
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it('uses a local acceptance identifier when a successful response has no ID', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 200 }));
    const mailer = createSmtp2goMailer(API_KEY, fetcher as typeof fetch);
    await expect(mailer.send(message())).resolves.toEqual({
      messageId: 'smtp2go-accepted:delivery-123',
    });
  });

  it('maps provider validation failures to permanent delivery errors', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: 'sender is not verified',
      error_code: 'E_UNVERIFIED_SENDER',
    }), { status: 400 }));
    const mailer = createSmtp2goMailer(API_KEY, fetcher as typeof fetch);
    await expect(mailer.send(message())).rejects.toMatchObject({
      name: 'PermanentOutboundError',
      code: 'smtp2go_rejected',
      message: 'sender is not verified',
    });
  });

  it('maps rate limits, server failures, and network failures to retryable errors', async () => {
    const rateLimited = createSmtp2goMailer(API_KEY, vi.fn(async () => (
      new Response(JSON.stringify({ error: 'API key ratelimit exceeded' }), { status: 429 })
    )) as typeof fetch);
    await expect(rateLimited.send(message())).rejects.toBeInstanceOf(RetryableOutboundError);
    await expect(rateLimited.send(message())).rejects.toMatchObject({ code: 'smtp2go_rate_limited' });

    const unavailable = createSmtp2goMailer(API_KEY, vi.fn(async () => (
      new Response('', { status: 503 })
    )) as typeof fetch);
    await expect(unavailable.send(message())).rejects.toMatchObject({
      name: 'RetryableOutboundError',
      code: 'smtp2go_unavailable',
    });

    const disconnected = createSmtp2goMailer(API_KEY, vi.fn(async () => {
      throw new TypeError('connection reset');
    }) as typeof fetch);
    await expect(disconnected.send(message())).rejects.toMatchObject({
      name: 'RetryableOutboundError',
      code: 'smtp2go_network_error',
    });
  });

  it('fails closed when the secret is missing or malformed', () => {
    expect(() => createSmtp2goMailer('')).toThrow(PermanentOutboundError);
    expect(() => createSmtp2goMailer('contains whitespace')).toThrowError(
      expect.objectContaining({ code: 'smtp2go_configuration_error' }),
    );
  });
});

function message(): OutboundMailerMessage {
  return {
    deliveryId: 'delivery-123',
    from: { email: 'sender@example.com', name: 'Sender Name' },
    to: ['recipient@example.net'],
    cc: ['copy@example.net'],
    bcc: ['hidden@example.net'],
    subject: 'Provider test',
    text: 'plain body',
    html: '<p>html body</p>',
    headers: { 'X-CF-Webmail-Delivery-ID': 'delivery-123' },
    attachments: [{
      disposition: 'attachment',
      filename: 'data.bin',
      type: 'application/octet-stream',
      content: new Uint8Array([0, 1, 254, 255]).buffer,
    }],
  };
}
