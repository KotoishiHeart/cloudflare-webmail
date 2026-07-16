import {
  authenticateAccessRequest,
  type AccessAuthResult,
} from './access-auth.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

export type WebRequestDependencies = {
  authenticate(request: Request, env: Env): Promise<AccessAuthResult>;
};

const DEFAULT_DEPENDENCIES: WebRequestDependencies = {
  authenticate: authenticateAccessRequest,
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
  return Response.json({ ok: false, error: 'not_found' }, { status: 404, headers: JSON_HEADERS });
}
