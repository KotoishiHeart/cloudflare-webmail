const ACCESS_REDIRECT_STATUS = 302;
const ACCESS_TIMEOUT_MS = 20_000;

export async function verifyAccessBoundary(deployment, fetch = globalThis.fetch) {
  const target = `https://${deployment.hostname}/`;
  let response;
  try {
    response = await fetch(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS),
      headers: { accept: 'text/html' },
    });
  } catch (error) {
    throw new Error(`Access boundary request failed: ${errorText(error)}`);
  }
  if (response.status !== ACCESS_REDIRECT_STATUS) {
    throw new Error(`Access boundary returned HTTP ${response.status} instead of 302`);
  }
  const location = response.headers.get('location');
  if (!location) throw new Error('Access boundary response has no Location header');
  let login;
  try {
    login = new URL(location, target);
  } catch {
    throw new Error('Access boundary returned an invalid login URL');
  }
  const expectedOrigin = new URL(deployment.access.teamDomain).origin;
  if (login.origin !== expectedOrigin) {
    throw new Error('Access boundary redirects to a different team domain');
  }
  const expectedPath = `/cdn-cgi/access/login/${deployment.hostname}`;
  if (login.pathname !== expectedPath) {
    throw new Error('Access boundary redirects to a different application hostname');
  }
  if (login.searchParams.get('kid') !== deployment.access.audience) {
    throw new Error('Access boundary audience differs from the deployment manifest');
  }
  return {
    hostname: deployment.hostname,
    status: response.status,
    loginOrigin: login.origin,
    audienceMatches: true,
  };
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
