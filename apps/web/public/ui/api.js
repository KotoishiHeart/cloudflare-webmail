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

export async function getMessages(mailboxId, folder, cursor = null, filters = {}) {
  const query = new URLSearchParams({ folder, limit: '30' });
  for (const [name, value] of Object.entries(filters)) {
    if (value !== '' && value !== 'all' && value !== 'any') query.set(name, value);
  }
  if (cursor) {
    query.set('before', String(cursor.before));
    query.set('beforeId', cursor.beforeId);
  }
  return requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/messages?${query}`);
}

export async function getMessage(messageId) {
  return requestJson(`/api/messages/${encodeURIComponent(messageId)}`);
}

export async function getMessageBody(message) {
  const [textResult, htmlResult] = await Promise.allSettled([
    fetchBody(message.bodyTextUrl, 'text/plain'),
    fetchBody(message.bodyHtmlUrl, 'text/html'),
  ]);
  const text = textResult.status === 'fulfilled' ? textResult.value : null;
  const html = htmlResult.status === 'fulfilled' ? htmlResult.value : null;
  if (text === null && html === null) {
    const failure = textResult.status === 'rejected'
      ? textResult.reason
      : htmlResult.status === 'rejected' ? htmlResult.reason : null;
    if (failure) throw failure;
    return { text: '本文は保存されていません。', html: null, source: 'missing' };
  }
  return {
    text: text?.content ?? '',
    html: html?.content ?? null,
    source: html?.source ?? text?.source ?? 'missing',
  };
}

async function fetchBody(url, accept) {
  if (!url) return null;
  const response = await fetch(url, { headers: { accept } });
  if (!response.ok) throw await responseError(response);
  return {
    content: await response.text(),
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
