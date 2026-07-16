import { formatBytes, fullDate } from './format.js';

const panel = document.querySelector('#detail-panel');
const placeholder = document.querySelector('#detail-placeholder');
const content = document.querySelector('#detail-content');
const actions = document.querySelector('#detail-actions');
const attachmentSection = document.querySelector('#attachment-section');
const attachmentList = document.querySelector('#attachment-list');
const attachmentTemplate = document.querySelector('#attachment-template');

export function showMessageDetail(detail, body, handlers) {
  const { message, attachments } = detail;
  placeholder.hidden = true;
  content.hidden = false;
  panel.classList.add('open');
  setText('#detail-date', fullDate(message.receivedAt));
  setText('#detail-state', statusLabel(message, body.source));
  setText('#detail-subject', message.subject || '（件名なし）');
  setText('#detail-sender', message.sender || '差出人不明');
  setText('#detail-recipients', message.recipients || message.deliveredTo);
  setText('#detail-cc', message.cc);
  document.querySelector('#detail-cc-row').hidden = !message.cc;
  renderBody(message, body);
  const rawLink = document.querySelector('#raw-link');
  rawLink.href = message.rawUrl;
  renderActions(message, handlers);
  renderAttachments(attachments);
  document.querySelector('#detail-subject').focus({ preventScroll: true });
}

export function showDetailLoading() {
  placeholder.hidden = true;
  content.hidden = false;
  panel.classList.add('open');
  setText('#detail-state', '読み込み中');
  setText('#detail-subject', 'メッセージを読み込んでいます…');
  setText('#detail-body', '');
  clearHtmlBody();
  actions.replaceChildren();
  attachmentSection.hidden = true;
}

export function closeMessageDetail() {
  panel.classList.remove('open');
  content.hidden = true;
  placeholder.hidden = false;
  clearHtmlBody();
}

function renderBody(message, body) {
  const frame = document.querySelector('#detail-html');
  const text = document.querySelector('#detail-body');
  const modes = document.querySelector('#body-modes');
  const showHtml = document.querySelector('#show-html-body');
  const showText = document.querySelector('#show-text-body');
  text.textContent = body.text || (body.html ? '' : '本文は保存されていません。');
  frame.title = `HTMLメール本文: ${message.subject || '件名なし'}`;
  frame.srcdoc = body.html || '';
  modes.hidden = body.html === null || body.text === '';
  const selectHtml = () => {
    frame.hidden = body.html === null;
    text.hidden = body.html !== null;
    showHtml.disabled = body.html !== null;
    showText.disabled = false;
  };
  const selectText = () => {
    frame.hidden = true;
    text.hidden = false;
    showHtml.disabled = false;
    showText.disabled = true;
  };
  showHtml.onclick = selectHtml;
  showText.onclick = selectText;
  if (body.html !== null) selectHtml();
  else selectText();
}

function clearHtmlBody() {
  const frame = document.querySelector('#detail-html');
  frame.srcdoc = '';
  frame.hidden = true;
  document.querySelector('#detail-body').hidden = false;
  document.querySelector('#body-modes').hidden = true;
}

function renderActions(message, handlers) {
  actions.replaceChildren();
  if (message.role === 'viewer') {
    const notice = document.createElement('span');
    notice.textContent = '閲覧専用';
    actions.append(notice);
    return;
  }
  addCallbackAction('返信', handlers.onReply);
  addCallbackAction('転送', handlers.onForward);
  addPatchAction(message.isRead ? '未読にする' : '既読にする', { isRead: !message.isRead }, handlers.onPatch);
  addPatchAction(message.isStarred ? 'スター解除' : 'スター', { isStarred: !message.isStarred }, handlers.onPatch);
  if (!message.isDeleted) {
    addPatchAction(message.isArchived ? '受信箱へ戻す' : 'アーカイブ', {
      isArchived: !message.isArchived,
    }, handlers.onPatch);
    addPatchAction('ゴミ箱へ', { isDeleted: true }, handlers.onPatch, 'danger');
  } else {
    addPatchAction('復元', { isDeleted: false }, handlers.onPatch);
  }
}

function addPatchAction(label, patch, onPatch, className = '') {
  addCallbackAction(label, () => onPatch(patch), className);
}

function addCallbackAction(label, callback, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.className = className;
  button.addEventListener('click', callback);
  actions.append(button);
}

function renderAttachments(attachments) {
  attachmentList.replaceChildren();
  attachmentSection.hidden = attachments.length === 0;
  for (const attachment of attachments) {
    const card = attachmentTemplate.content.firstElementChild.cloneNode(true);
    card.href = attachment.downloadUrl;
    card.querySelector('.attachment-name').textContent = attachment.filename;
    card.querySelector('.attachment-meta').textContent =
      `${attachment.contentType} · ${formatBytes(attachment.size)}`;
    attachmentList.append(card);
  }
}

function statusLabel(message, bodySource) {
  if (message.status === 'quarantined') return '隔離済みメッセージ';
  if (message.status === 'queued') return '送信待ち';
  if (message.status === 'sending') return '送信処理中';
  if (message.status === 'sent') return '送信済み';
  if (message.status === 'failed') return `送信失敗${message.processingError ? ` (${message.processingError})` : ''}`;
  if (bodySource === 'sanitized-html') return 'HTML本文を安全なsandboxで表示';
  return message.isRead ? '既読' : '未読';
}

function setText(selector, value) {
  document.querySelector(selector).textContent = value || '';
}
