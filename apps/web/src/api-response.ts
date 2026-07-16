export const API_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

export function apiData(data: unknown, status = 200): Response {
  return Response.json({ ok: true, data }, { status, headers: API_HEADERS });
}

export function apiError(error: string, status: number, allow?: string): Response {
  const headers = new Headers(API_HEADERS);
  if (allow !== undefined) headers.set('allow', allow);
  return Response.json({ ok: false, error }, { status, headers });
}

export function objectHeaders(contentType: string): Headers {
  return new Headers({
    'content-type': contentType,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });
}
