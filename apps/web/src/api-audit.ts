import { recordIdentityAuditEventSafely, type AuditCategory } from '@cf-webmail/database';
import type { AccessIdentity } from './access-auth.js';

export async function auditApiResponse(
  request: Request,
  db: D1Database,
  identity: AccessIdentity,
  response: Response,
  now: number,
): Promise<void> {
  const url = new URL(request.url);
  if (!shouldAudit(request.method, url.pathname)) return;
  const category = categoryForPath(url.pathname);
  const mailboxId = url.pathname.match(/\/mailboxes\/([0-9a-f-]{36})(?:\/|$)/iu)?.[1];
  const target = targetForPath(url.pathname);
  await recordIdentityAuditEventSafely(db, {
    identity,
    ...(mailboxId === undefined ? {} : { mailboxId }),
    category,
    severity: severityFor(request.method, url.pathname, response.status),
    action: actionFor(request.method, url.pathname, category),
    targetType: target.type,
    targetId: target.id,
    requestId: request.headers.get('cf-ray') ?? request.headers.get('x-request-id') ?? '',
    ipAddress: request.headers.get('cf-connecting-ip') ?? '',
    userAgent: request.headers.get('user-agent') ?? '',
    details: { status: response.status, route: redactedRoute(url.pathname) },
    now,
  });
}

function shouldAudit(method: string, pathname: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method)
    || /\/messages\/[^/]+\/(raw|attachments\/\d+)$/u.test(pathname);
}

function categoryForPath(pathname: string): AuditCategory {
  if (pathname.includes('/rules') || pathname.includes('/rule-runs')) return 'rule';
  if (pathname.includes('/labels')) return 'label';
  if (pathname === '/api/preferences') return 'preference';
  if (pathname.includes('/admin')) return 'admin';
  return 'message';
}

function actionFor(method: string, pathname: string, category: AuditCategory): string {
  if (pathname.endsWith('/preview')) return 'rule.preview';
  if (pathname.endsWith('/apply')) return 'rule.apply';
  if (pathname.endsWith('/undo')) return 'rule.undo';
  if (pathname.endsWith('/raw')) return 'message.download_raw';
  if (pathname.includes('/attachments/')) return 'message.download_attachment';
  return `${category}.${method.toLowerCase()}`;
}

function targetForPath(pathname: string): { type: string; id: string } {
  const segments = pathname.split('/').filter(Boolean);
  for (const marker of ['rule-runs', 'rules', 'messages', 'labels']) {
    const index = segments.lastIndexOf(marker);
    const candidate = segments[index + 1];
    if (index >= 0 && candidate !== undefined) return { type: marker, id: candidate };
  }
  return { type: '', id: '' };
}

function severityFor(
  method: string,
  pathname: string,
  status: number,
): 'low' | 'medium' | 'high' {
  if (status >= 500 || method === 'DELETE' || pathname.endsWith('/apply')) return 'high';
  if (status >= 400 || method !== 'GET') return 'medium';
  return 'low';
}

function redactedRoute(pathname: string): string {
  return pathname
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/giu, ':id')
    .replace(/\/attachments\/\d+$/u, '/attachments/:ordinal');
}
