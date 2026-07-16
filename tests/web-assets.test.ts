import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { handleWebRequest } from '../apps/web/src/app.js';

const AUTHENTICATED = {
  authenticate: async () => ({
    ok: true as const,
    identity: {
      issuer: 'https://team.cloudflareaccess.com',
      subject: 'asset-user',
      email: 'asset-user@example.com',
    },
  }),
};

describe('authenticated Static Assets', () => {
  it('serves the SPA shell with restrictive browser security headers', async () => {
    const response = await handleWebRequest(
      new Request('https://webmail.example.com/'),
      env,
      AUTHENTICATED,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    const html = await response.text();
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    expect(html).toContain('Cloudflare Access');
  });

  it('serves module assets and uses the SPA fallback for UI routes', async () => {
    const moduleResponse = await handleWebRequest(
      new Request('https://webmail.example.com/app.js'),
      env,
      AUTHENTICATED,
    );
    expect(moduleResponse.status).toBe(200);
    expect(moduleResponse.headers.get('content-type')).toContain('javascript');
    await expect(moduleResponse.text()).resolves.toContain("from './ui/api.js'");

    const fallback = await handleWebRequest(
      new Request('https://webmail.example.com/inbox'),
      env,
      AUTHENTICATED,
    );
    expect(fallback.status).toBe(200);
    await expect(fallback.text()).resolves.toContain('<title>Cloudflare Webmail</title>');
  });

  it('rejects mutation methods for the asset surface', async () => {
    const response = await handleWebRequest(
      new Request('https://webmail.example.com/', { method: 'POST' }),
      env,
      AUTHENTICATED,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('serves the administration and PWA surfaces without public caching', async () => {
    const admin = await handleWebRequest(
      new Request('https://webmail.example.com/admin.html'), env, AUTHENTICATED,
    );
    expect(admin.status).toBe(200);
    expect(admin.headers.get('cache-control')).toContain('private');
    await expect(admin.text()).resolves.toContain('src="/admin.js"');

    const worker = await handleWebRequest(
      new Request('https://webmail.example.com/service-worker.js'), env, AUTHENTICATED,
    );
    expect(worker.status).toBe(200);
    expect(worker.headers.get('service-worker-allowed')).toBe('/');
    expect(worker.headers.get('cache-control')).toContain('no-cache');
    const source = await worker.text();
    expect(source).toContain("url.pathname.startsWith('/api/')");
  });
});
