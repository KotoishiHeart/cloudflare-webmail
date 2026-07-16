import { shortDate, senderLabel } from './format.js';

const list = document.querySelector('#message-list');
const template = document.querySelector('#message-template');
const empty = document.querySelector('#empty-state');
const loadMore = document.querySelector('#load-more');

export function renderMessageList(state, onSelect) {
  list.replaceChildren();
  empty.hidden = state.messages.length !== 0;
  loadMore.hidden = state.nextCursor === null;
  for (const message of state.messages) {
    const row = template.content.firstElementChild.cloneNode(true);
    row.dataset.messageId = message.id;
    row.classList.toggle('read', message.isRead);
    row.classList.toggle('active', message.id === state.selectedMessageId);
    row.querySelector('.message-sender').textContent = message.direction === 'outbound'
      ? `宛先: ${message.recipients || 'BCCのみ'}`
      : senderLabel(message.sender);
    row.querySelector('time').textContent = shortDate(message.receivedAt);
    row.querySelector('time').dateTime = new Date(message.receivedAt).toISOString();
    row.querySelector('.message-subject').textContent = message.subject || '（件名なし）';
    row.querySelector('.message-preview').textContent = message.textPreview || '本文プレビューなし';
    row.querySelector('.message-badges').textContent = badges(message);
    row.setAttribute('aria-pressed', String(message.id === state.selectedMessageId));
    row.addEventListener('click', () => onSelect(message.id));
    list.append(row);
  }
}

export function setMessageListBusy(busy) {
  list.setAttribute('aria-busy', String(busy));
  loadMore.disabled = busy;
}

function badges(message) {
  const values = [];
  if (message.isStarred) values.push('★');
  if (message.attachmentCount > 0) values.push('⌕');
  if (message.status === 'quarantined') values.push('!');
  if (message.status === 'queued') values.push('送信待ち');
  if (message.status === 'sending') values.push('送信中');
  if (message.status === 'failed') values.push('送信失敗');
  return values.join(' ');
}
