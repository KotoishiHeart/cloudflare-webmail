import {
  authenticateAccessRequest,
  type AccessAuthResult,
} from './access-auth.js';
import { routeApi } from './api-router.js';
import { apiError } from './api-response.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

export type WebRequestDependencies = {
  authenticate(request: Request, env: Env): Promise<AccessAuthResult>;
  now?(): number;
};

const DEFAULT_DEPENDENCIES: WebRequestDependencies = {
  authenticate: authenticateAccessRequest,
  now: Date.now,
};

export async function handleWebRequest(
  request: Request,
  env: Env,
  dependencies: WebRequestDependencies = DEFAULT_DEPENDENCIES,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/healthz') {
    return Response.json(
      { ok: true, service: 'cf-webmail-web', architectureVersion: 1 },
      { headers: JSON_HEADERS },
    );
  }
  const auth = await dependencies.authenticate(request, env);
  if (!auth.ok) {
    return Response.json(
      { ok: false, error: auth.code },
      { status: auth.status, headers: JSON_HEADERS },
    );
  }
  try {
    if (url.pathname.startsWith('/api/')) {
      return await routeApi(request, env, auth.identity, dependencies.now?.() ?? Date.now());
    }
    return Response.json(
      { ok: false, error: 'not_found' },
      { status: 404, headers: JSON_HEADERS },
    );
  } catch (error) {
    console.error(JSON.stringify({
      event: 'web.request_failed',
      path: url.pathname,
      errorType: error instanceof Error ? error.name : typeof error,
      cfRay: request.headers.get('cf-ray') ?? '',
    }));
    return apiError('internal_error', 500);
  }
}
