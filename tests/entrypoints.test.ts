import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
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
});
