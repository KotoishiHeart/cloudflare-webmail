import { describe, expect, it } from 'vitest';
import { handleWebRequest } from '../apps/web/src/app.js';

describe('safe staged entrypoints', () => {
  it('exposes only a bounded web health response', async () => {
    const response = handleWebRequest(new Request('https://webmail.example.com/healthz'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, architectureVersion: 1 });
  });
});
