import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import {
  readAccessConfig,
  type AccessConfig,
  type AccessConfigSource,
} from './access-config.js';

const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
const MAX_ACCESS_JWT_LENGTH = 16 * 1024;

export type AccessIdentity = {
  issuer: string;
  subject: string;
  email: string;
};

export type AccessAuthResult =
  | { ok: true; identity: AccessIdentity }
  | {
    ok: false;
    status: 401 | 403 | 503;
    code: 'access_token_missing' | 'access_token_invalid' | 'identity_unsupported'
      | 'access_not_configured';
  };

export async function authenticateAccessRequest(
  request: Request,
  env: AccessConfigSource,
): Promise<AccessAuthResult> {
  const config = readAccessConfig(env);
  if (config === null) {
    return { ok: false, status: 503, code: 'access_not_configured' };
  }

  const token = request.headers.get(ACCESS_JWT_HEADER)?.trim() ?? '';
  if (token === '' || token.length > MAX_ACCESS_JWT_LENGTH) {
    return { ok: false, status: 401, code: 'access_token_missing' };
  }

  try {
    const keys = createRemoteJWKSet(new URL(`${config.teamDomain}/cdn-cgi/access/certs`));
    const identity = await verifyAccessToken(token, config, keys);
    return identity === null
      ? { ok: false, status: 403, code: 'identity_unsupported' }
      : { ok: true, identity };
  } catch {
    return { ok: false, status: 401, code: 'access_token_invalid' };
  }
}

export async function verifyAccessToken(
  token: string,
  config: AccessConfig,
  keys: JWTVerifyGetKey,
): Promise<AccessIdentity | null> {
  const { payload } = await jwtVerify(token, keys, {
    issuer: config.teamDomain,
    audience: config.audience,
    algorithms: ['RS256'],
  });
  const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (
    payload.type !== 'app'
    || subject === ''
    || subject.length > 512
    || email.length < 3
    || email.length > 320
  ) {
    return null;
  }
  return { issuer: config.teamDomain, subject, email };
}
