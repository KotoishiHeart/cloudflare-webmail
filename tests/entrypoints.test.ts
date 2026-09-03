import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { handleWebRequest } from '../apps/web/src/app.js';

describe('safe staged entrypoints', () => {
  it('exposes only a bounded web health response', async () => {
    const response = await handleWebRequest(
      new Request('https://webmail.example.com/healthz'),
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, architectureVersion: 1 });
  });

  it('fails closed before routing protected requests', async () => {
    const response = await handleWebRequest(
      new Request('https://webmail.example.com/'),
      env,
      {
        authenticate: async () => ({
          ok: false,
          status: 401,
          code: 'access_token_missing',
        }),
      },
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'access_token_missing',
    });
  });

  it('logs bounded D1 failure details without exposing them to API clients', async () => {
    const failure = new Error('D1_ERROR: preference read failed\nwith control data', {
      cause: new Error('database cause'),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await handleWebRequest(
      new Request('https://webmail.example.com/api/preferences'),
      {
        ...env,
        DB: {
          prepare() { throw failure; },
        } as unknown as D1Database,
      },
      {
        authenticate: async () => ({
          ok: true,
          identity: {
            issuer: 'https://team.cloudflareaccess.com',
            subject: 'diagnostic-user',
            email: 'diagnostic-user@example.com',
          },
        }),
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'internal_error' });
    expect(error).toHaveBeenCalledOnce();
    const record = JSON.parse(String(error.mock.calls[0]?.[0]));
    expect(record).toMatchObject({
      event: 'web.request_failed',
      path: '/api/preferences',
      errorType: 'Error',
      errorMessage: 'D1_ERROR: preference read failed with control data',
      errorCause: 'database cause',
    });
    error.mockRestore();
  });
});
