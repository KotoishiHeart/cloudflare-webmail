const dialog = document.querySelector('#compose-dialog');
const form = document.querySelector('#compose-form');
const submit = document.querySelector('#compose-submit');
let requestId = '';
let submitHandler;
let composeMode = 'new';
let sourceMessageId = '';
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const attachmentInput = document.querySelector('#compose-attachments');
const composeHint = document.querySelector('#compose-hint');

export function bindCompose(onSubmit) {
  submitHandler = onSubmit;
  document.querySelector('#compose-close').addEventListener('click', closeCompose);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeCompose();
  });
  form.addEventListener('submit', submitCompose);
  attachmentInput.addEventListener('change', renderAttachmentHint);
}

export function openCompose(mailbox, draft = {}) {
  if (!mailbox || mailbox.role === 'viewer') return;
  requestId = crypto.randomUUID();
  composeMode = draft.composeMode || 'new';
  sourceMessageId = draft.sourceMessageId || '';
  form.reset();
  document.querySelector('#compose-title').textContent = composeTitle(composeMode);
  document.querySelector('#compose-from').textContent = `差出人: ${mailbox.address}`;
  setValue('#compose-to', draft.to);
  setValue('#compose-cc', draft.cc);
  setValue('#compose-bcc', draft.bcc);
  setValue('#compose-subject', draft.subject);
  setValue('#compose-text', draft.text);
  renderAttachmentHint();
  dialog.showModal();
  document.querySelector('#compose-to').focus();
}

export function openReplyCompose(mailbox, detail, body) {
  const { message } = detail;
  const replyAddress = extractAddresses(message.replyTo || message.sender)[0] || '';
  const cc = extractAddresses(message.cc)
    .filter((address) => address !== mailbox.address.toLowerCase() && address !== replyAddress);
  openCompose(mailbox, {
    composeMode: 'reply',
    sourceMessageId: message.id,
    to: [replyAddress].filter(Boolean),
    cc,
    subject: withPrefix(message.subject, 'Re:'),
    text: `\n\nOn ${message.dateHeader || new Date(message.receivedAt).toLocaleString()} ${message.sender || ''} wrote:\n${quoteText(body.text || message.textPreview)}`,
  });
}

export function openForwardCompose(mailbox, detail, body) {
  const { message } = detail;
  openCompose(mailbox, {
    composeMode: 'forward',
    sourceMessageId: message.id,
    subject: withPrefix(message.subject, 'Fwd:'),
    text: [
      '',
      '',
      '---------- Forwarded message ---------',
      `From: ${message.sender || ''}`,
      `Date: ${message.dateHeader || new Date(message.receivedAt).toLocaleString()}`,
      `Subject: ${message.subject || ''}`,
      `To: ${message.recipients || message.deliveredTo || ''}`,
      '',
      body.text || message.textPreview || '',
    ].join('\n'),
  });
}

export function closeCompose() {
  if (dialog.open) dialog.close();
  requestId = '';
  composeMode = 'new';
  sourceMessageId = '';
}

async function submitCompose(event) {
  event.preventDefault();
  if (!submitHandler || !requestId) return;
  const attachments = selectedAttachments();
  if (attachments === null) return;
  submit.disabled = true;
  try {
    await submitHandler({
      requestId,
      to: addresses('#compose-to'),
      cc: addresses('#compose-cc'),
      bcc: addresses('#compose-bcc'),
      subject: document.querySelector('#compose-subject').value,
      text: document.querySelector('#compose-text').value,
      composeMode,
      sourceMessageId: sourceMessageId || null,
      attachments,
    });
    closeCompose();
  } catch {
    // The app-level handler keeps the draft open and displays the API error.
  } finally {
    submit.disabled = false;
  }
}

function selectedAttachments() {
  const files = [...attachmentInput.files];
  const total = files.reduce((bytes, file) => bytes + file.size, 0);
  let error = '';
  if (files.length > MAX_ATTACHMENTS) error = `添付は最大${MAX_ATTACHMENTS}個です。`;
  else if (files.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
    error = '1ファイルの上限は10 MiBです。';
  } else if (total > MAX_TOTAL_ATTACHMENT_BYTES) error = '添付の合計上限は20 MiBです。';
  attachmentInput.setCustomValidity(error);
  if (error) {
    attachmentInput.reportValidity();
    return null;
  }
  return files;
}

function renderAttachmentHint() {
  const files = [...attachmentInput.files];
  const total = files.reduce((bytes, file) => bytes + file.size, 0);
  composeHint.textContent = files.length === 0
    ? '最大8個・1ファイル10 MiB・合計20 MiB'
    : `${files.length}個選択・${formatBytes(total)} / 20 MiB`;
  selectedAttachments();
}

function formatBytes(value) {
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function setValue(selector, value) {
  document.querySelector(selector).value = Array.isArray(value) ? value.join(', ') : value || '';
}

function composeTitle(mode) {
  if (mode === 'reply') return '返信';
  if (mode === 'forward') return '転送';
  return 'メールを作成';
}

function withPrefix(subject, prefix) {
  const value = subject || '';
  const covered = prefix === 'Re:' ? /^\s*re\s*:/iu : /^\s*(?:fwd?|転送)\s*:/iu;
  return covered.test(value) ? value : `${prefix} ${value}`.trim();
}

function quoteText(value) {
  return String(value || '').split('\n').map((line) => `> ${line}`).join('\n');
}

function extractAddresses(value) {
  const matches = String(value || '').toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/gu);
  return [...new Set(matches || [])];
}

function addresses(selector) {
  return document.querySelector(selector).value
    .split(/[,;\n]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
}
