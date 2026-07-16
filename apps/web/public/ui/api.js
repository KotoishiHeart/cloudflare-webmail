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

export async function getMessages(mailboxId, folder, cursor = null, filters = {}, limit = 30) {
  const query = new URLSearchParams({ folder, limit: String(limit) });
  for (const [name, value] of Object.entries(filters)) {
    if (value !== '' && value !== 'all' && value !== 'any') query.set(name, value);
  }
  if (cursor) {
    query.set('before', String(cursor.before));
    query.set('beforeId', cursor.beforeId);
  }
  return requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/messages?${query}`);
}

export async function getPreferences() {
  return requestJson('/api/preferences');
}

export async function patchPreferences(patch) {
  return requestJson('/api/preferences', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function getLabels(mailboxId) {
  return requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/labels`);
}

export async function createLabel(mailboxId, input) {
  return requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/labels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function deleteLabel(mailboxId, labelId) {
  return requestJson(
    `/api/mailboxes/${encodeURIComponent(mailboxId)}/labels/${encodeURIComponent(labelId)}`,
    { method: 'DELETE' },
  );
}

export async function putMessageLabels(messageId, labelIds) {
  return requestJson(`/api/messages/${encodeURIComponent(messageId)}/labels`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ labelIds }),
  });
}

export async function getRules(mailboxId) {
  return requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/rules`);
}

export async function createRule(mailboxId, input) {
  return requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/rules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function patchRule(mailboxId, ruleId, patch) {
  return requestJson(
    `/api/mailboxes/${encodeURIComponent(mailboxId)}/rules/${encodeURIComponent(ruleId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );
}

export async function deleteRule(mailboxId, ruleId) {
  return requestJson(
    `/api/mailboxes/${encodeURIComponent(mailboxId)}/rules/${encodeURIComponent(ruleId)}`,
    { method: 'DELETE' },
  );
}

export async function previewRule(mailboxId, ruleId) {
  return ruleRunRequest(mailboxId, `rules/${encodeURIComponent(ruleId)}/preview`);
}

export async function getRuleRuns(mailboxId) {
  return requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/rule-runs`);
}

export async function getRuleRun(mailboxId, runId) {
  return requestJson(
    `/api/mailboxes/${encodeURIComponent(mailboxId)}/rule-runs/${encodeURIComponent(runId)}`,
  );
}

export async function applyRuleRun(mailboxId, runId) {
  return ruleRunRequest(mailboxId, `rule-runs/${encodeURIComponent(runId)}/apply`);
}

export async function undoRuleRun(mailboxId, runId) {
  return ruleRunRequest(mailboxId, `rule-runs/${encodeURIComponent(runId)}/undo`);
}

function ruleRunRequest(mailboxId, suffix) {
  return requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/${suffix}`, {
    method: 'POST',
  });
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
  const { requestId, attachments = [], ...message } = input;
  if (attachments.length > 0) {
    const form = new FormData();
    form.set('payload', JSON.stringify(message));
    for (const attachment of attachments) form.append('attachments', attachment);
    return requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/messages`, {
      method: 'POST',
      headers: { 'idempotency-key': requestId },
      body: form,
    });
  }
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
