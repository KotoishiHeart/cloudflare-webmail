import { ApiError } from './api.js';

export const adminApi = {
  session: () => get('/api/session'),
  summary: () => get('/api/admin/summary'),
  users: () => get('/api/admin/users'),
  user: (userId) => get(`/api/admin/users/${id(userId)}`),
  createUser: (input) => json('/api/admin/users', 'POST', input),
  patchUser: (userId, patch) => json(`/api/admin/users/${id(userId)}`, 'PATCH', patch),
  setAdministrator: (userId, enabled) => request(
    `/api/admin/users/${id(userId)}/administrator`, { method: enabled ? 'PUT' : 'DELETE' },
  ),
  addIdentity: (userId, identity) => json(
    `/api/admin/users/${id(userId)}/identities`, 'POST', identity,
  ),
  removeIdentity: (userId, identity) => json(
    `/api/admin/users/${id(userId)}/identities`, 'DELETE', identity,
  ),
  mailboxes: () => get('/api/admin/mailboxes'),
  mailbox: (mailboxId) => get(`/api/admin/mailboxes/${id(mailboxId)}`),
  createMailbox: (input) => json('/api/admin/mailboxes', 'POST', input),
  patchMailbox: (mailboxId, patch) => json(
    `/api/admin/mailboxes/${id(mailboxId)}`, 'PATCH', patch,
  ),
  addAddress: (mailboxId, input) => json(
    `/api/admin/mailboxes/${id(mailboxId)}/addresses`, 'POST', input,
  ),
  patchAddress: (mailboxId, input) => json(
    `/api/admin/mailboxes/${id(mailboxId)}/addresses`, 'PATCH', input,
  ),
  removeAddress: (mailboxId, input) => json(
    `/api/admin/mailboxes/${id(mailboxId)}/addresses`, 'DELETE', input,
  ),
  setMember: (mailboxId, userId, role) => json(
    `/api/admin/mailboxes/${id(mailboxId)}/members/${id(userId)}`, 'PUT', { role },
  ),
  removeMember: (mailboxId, userId) => request(
    `/api/admin/mailboxes/${id(mailboxId)}/members/${id(userId)}`, { method: 'DELETE' },
  ),
  auditEvents: (filters = {}) => get(`/api/admin/audit-events?${query(filters)}`),
  deliveryEvents: (filters = {}) => get(`/api/admin/delivery-events?${query(filters)}`),
  retentionPolicy: (mailboxId) => get(
    `/api/admin/mailboxes/${id(mailboxId)}/retention-policy`,
  ),
  saveRetentionPolicy: (mailboxId, patch) => json(
    `/api/admin/mailboxes/${id(mailboxId)}/retention-policy`, 'PATCH', patch,
  ),
  retentionRuns: (mailboxId) => get(
    `/api/admin/mailboxes/${id(mailboxId)}/retention-runs`,
  ),
  retentionRun: (runId) => get(`/api/admin/retention-runs/${id(runId)}`),
  createRetentionPreview: (mailboxId, input) => json(
    `/api/admin/mailboxes/${id(mailboxId)}/retention-runs`, 'POST', input,
  ),
  approveRetentionRun: (runId, input) => json(
    `/api/admin/retention-runs/${id(runId)}/approve`, 'POST', input,
  ),
  cancelRetentionRun: (runId) => request(
    `/api/admin/retention-runs/${id(runId)}/cancel`, { method: 'POST' },
  ),
};

function get(path) {
  return request(path);
}

function json(path, method, body) {
  return request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function request(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: { accept: 'application/json', ...init.headers },
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(`http_${response.status}`, response.status);
  }
  if (!response.ok || payload?.ok !== true) {
    throw new ApiError(payload?.error || `http_${response.status}`, response.status);
  }
  return payload.data;
}

function id(value) {
  return encodeURIComponent(value);
}

function query(filters) {
  const params = new URLSearchParams({ limit: '50' });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return params;
}
