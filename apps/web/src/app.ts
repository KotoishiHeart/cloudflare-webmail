const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

export function handleWebRequest(request: Request): Response {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/healthz') {
    return Response.json(
      { ok: true, service: 'cf-webmail-web', architectureVersion: 1 },
      { headers: JSON_HEADERS },
    );
  }
  return Response.json({ ok: false, error: 'not_found' }, { status: 404, headers: JSON_HEADERS });
}
