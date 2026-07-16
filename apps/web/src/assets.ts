const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join('; '),
  'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const;

export async function serveAuthenticatedAsset(
  request: Request,
  assets: Fetcher,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return Response.json(
      { ok: false, error: 'method_not_allowed' },
      {
        status: 405,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          allow: 'GET, HEAD',
        },
      },
    );
  }
  const response = await assets.fetch(request);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  const pathname = new URL(request.url).pathname;
  if (pathname === '/service-worker.js') {
    headers.set('cache-control', 'private, no-cache');
    headers.set('service-worker-allowed', '/');
  } else if (
    pathname === '/' || pathname.endsWith('.html') || pathname === '/manifest.webmanifest'
  ) {
    headers.set('cache-control', 'private, no-cache');
  } else {
    headers.set('cache-control', 'private, max-age=3600');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
