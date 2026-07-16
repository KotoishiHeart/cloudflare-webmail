export class ApiError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export async function getSession() {
  return requestJson('/api/session');
}

export async function getMessages(mailboxId, folder, cursor = null) {
  const query = new URLSearchParams({ folder, limit: '30' });
  if (cursor) {
    query.set('before', String(cursor.before));
    query.set('beforeId', cursor.beforeId);
  }
  return requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/messages?${query}`);
}

export async function getMessage(messageId) {
  return requestJson(`/api/messages/${encodeURIComponent(messageId)}`);
}

export async function getMessageBody(bodyUrl) {
  if (!bodyUrl) return { text: '本文は保存されていません。', source: 'missing' };
  const response = await fetch(bodyUrl, { headers: { accept: 'text/plain' } });
  if (!response.ok) throw await responseError(response);
  return {
    text: await response.text(),
    source: response.headers.get('x-webmail-body-source') || 'text',
  };
}

export async function patchMessage(messageId, patch) {
  return requestJson(`/api/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function createMessage(mailboxId, input) {
  const { requestId, ...message } = input;
  return requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': requestId,
    },
    body: JSON.stringify(message),
  });
}

async function requestJson(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: { accept: 'application/json', ...init.headers },
  });
  if (!response.ok) throw await responseError(response);
  const payload = await response.json();
  if (!payload || payload.ok !== true) throw new ApiError('invalid_response', response.status);
  return payload.data;
}

async function responseError(response) {
  let code = `http_${response.status}`;
  try {
    const payload = await response.json();
    if (typeof payload?.error === 'string') code = payload.error;
  } catch {
    // A non-JSON error page is reduced to its status code.
  }
  return new ApiError(code, response.status);
}
