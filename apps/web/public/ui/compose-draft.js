const PREFIX = 'cf-webmail:draft:v1:';
const MAX_SAVED_BYTES = 600 * 1024;
const SAVE_DELAY_MS = 500;
const FIELD_SELECTORS = {
  to: '#compose-to',
  cc: '#compose-cc',
  bcc: '#compose-bcc',
  subject: '#compose-subject',
  text: '#compose-text',
};

export function createComposeDraftController(form) {
  const status = document.querySelector('#compose-draft-status');
  let activeKey = '';
  let mode = 'new';
  let sourceMessageId = '';
  let timer = 0;

  form.addEventListener('input', scheduleSave);
  window.addEventListener('beforeunload', saveNow);

  function begin(mailboxId, composeMode, sourceId) {
    window.clearTimeout(timer);
    mode = composeMode;
    sourceMessageId = sourceId;
    activeKey = `${PREFIX}${mailboxId}:${composeMode}:${sourceId || 'new'}`;
    try {
      const raw = window.localStorage.getItem(activeKey);
      if (raw === null) {
        status.textContent = 'この端末内に自動保存します（添付ファイルを除く）。';
        return null;
      }
      if (new TextEncoder().encode(raw).byteLength > MAX_SAVED_BYTES) throw new Error('oversize');
      const value = JSON.parse(raw);
      if (!validDraft(value, composeMode, sourceId)) throw new Error('invalid');
      status.textContent = 'この端末に保存された下書きを復元しました。';
      return value;
    } catch {
      status.textContent = '端末内下書きを復元できませんでした。新しい内容で開始します。';
      return null;
    }
  }

  function scheduleSave() {
    if (!activeKey) return;
    window.clearTimeout(timer);
    status.textContent = '端末内下書きを保存中…';
    timer = window.setTimeout(saveNow, SAVE_DELAY_MS);
  }

  function saveNow() {
    window.clearTimeout(timer);
    if (!activeKey) return;
    const value = snapshot();
    try {
      if (Object.values(value.fields).every((field) => field === '')) {
        window.localStorage.removeItem(activeKey);
        status.textContent = '保存する下書きはありません。';
        return;
      }
      const raw = JSON.stringify(value);
      if (new TextEncoder().encode(raw).byteLength > MAX_SAVED_BYTES) throw new Error('oversize');
      window.localStorage.setItem(activeKey, raw);
      status.textContent = 'この端末内に下書きを保存しました。';
    } catch {
      status.textContent = '端末内下書きを保存できませんでした。';
    }
  }

  function clear() {
    window.clearTimeout(timer);
    if (activeKey) {
      try {
        window.localStorage.removeItem(activeKey);
      } catch {
        // Closing or sending must continue even when local storage is unavailable.
      }
    }
    activeKey = '';
    status.textContent = '端末内下書きを削除しました。';
  }

  function snapshot() {
    return {
      version: 1,
      composeMode: mode,
      sourceMessageId,
      updatedAt: Date.now(),
      fields: Object.fromEntries(
        Object.entries(FIELD_SELECTORS).map(([name, selector]) => [
          name,
          document.querySelector(selector).value,
        ]),
      ),
    };
  }

  return { begin, saveNow, clear };
}

function validDraft(value, mode, sourceMessageId) {
  if (
    typeof value !== 'object' || value === null || value.version !== 1
    || value.composeMode !== mode || value.sourceMessageId !== sourceMessageId
    || typeof value.fields !== 'object' || value.fields === null
  ) return false;
  const limits = { to: 8192, cc: 8192, bcc: 8192, subject: 998, text: 512 * 1024 };
  return Object.entries(limits).every(([name, maximum]) => (
    typeof value.fields[name] === 'string'
    && value.fields[name].length <= maximum
    && !value.fields[name].includes('\u0000')
  ));
}
