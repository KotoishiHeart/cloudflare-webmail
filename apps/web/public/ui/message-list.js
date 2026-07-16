import { shortDate, senderLabel } from './format.js';
import { hasActiveSearch } from './search.js';

const list = document.querySelector('#message-list');
const template = document.querySelector('#message-template');
const empty = document.querySelector('#empty-state');
const loadMore = document.querySelector('#load-more');

export function renderMessageList(state, handlers) {
  list.replaceChildren();
  empty.hidden = state.messages.length !== 0;
  document.querySelector('#empty-title').textContent = hasActiveSearch(state.searchFilters)
    ? '条件に一致するメールはありません'
    : 'ここにはまだメールがありません';
  document.querySelector('#empty-description').textContent = hasActiveSearch(state.searchFilters)
    ? '検索語や詳細条件を変更して、もう一度お試しください。'
    : '新しいメッセージが届くと、この一覧に表示されます。';
  loadMore.hidden = state.nextCursor === null;
  for (const message of state.messages) {
    const row = template.content.firstElementChild.cloneNode(true);
    row.dataset.messageId = message.id;
    row.classList.toggle('read', message.isRead);
    row.classList.toggle('active', message.id === state.selectedMessageId);
    row.classList.toggle('selected', state.selectedMessageIds.has(message.id));
    row.querySelector('.message-sender').textContent = message.direction === 'outbound'
      ? `宛先: ${message.recipients || 'BCCのみ'}`
      : senderLabel(message.sender);
    row.querySelector('time').textContent = shortDate(message.receivedAt);
    row.querySelector('time').dateTime = new Date(message.receivedAt).toISOString();
    row.querySelector('.message-subject').textContent = message.subject || '（件名なし）';
    row.querySelector('.message-preview').textContent = message.textPreview || '本文プレビューなし';
    row.querySelector('.message-badges').textContent = badges(message);
    const open = row.querySelector('.message-open');
    open.setAttribute('aria-pressed', String(message.id === state.selectedMessageId));
    open.addEventListener('click', () => handlers.onSelect(message.id));
    const checkbox = row.querySelector('[data-message-select]');
    checkbox.closest('.message-select').hidden = !handlers.selectable;
    checkbox.disabled = !handlers.selectable;
    checkbox.checked = state.selectedMessageIds.has(message.id);
    checkbox.setAttribute('aria-label', `${message.subject || '件名なし'}を選択`);
    checkbox.addEventListener('change', () => {
      row.classList.toggle('selected', checkbox.checked);
      handlers.onToggle(message.id, checkbox.checked);
    });
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
  values.push(...(message.labels || []).slice(0, 2).map((label) => label.name));
  if (message.attachmentCount > 0) values.push('⌕');
  if (message.status === 'quarantined') values.push('!');
  if (message.status === 'queued') values.push('送信待ち');
  if (message.status === 'sending') values.push('送信中');
  if (message.status === 'failed') values.push('送信失敗');
  return values.join(' ');
}
