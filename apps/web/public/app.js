import {
  getMessage,
  getMessageBody,
  getMessages,
  getSession,
  patchMessage,
  createMessage,
} from './ui/api.js';
import { bindCompose, openCompose } from './ui/compose.js';
import {
  closeMessageDetail,
  showDetailLoading,
  showMessageDetail,
} from './ui/message-detail.js';
import { renderMessageList, setMessageListBusy } from './ui/message-list.js';
import {
  EMPTY_SEARCH_FILTERS,
  bindSearch,
  hasActiveSearch,
  renderSearch,
} from './ui/search.js';
import {
  appendMessagePage,
  replaceMessagePage,
  selectFolder,
  selectMailbox,
  setSearchFilters,
  state,
} from './ui/state.js';
import { bindShell, renderFolder, renderSession, showStatus } from './ui/shell.js';

bindShell({
  onMailbox: changeMailbox,
  onFolder: changeFolder,
  onRefresh: () => loadMessages(false),
  onLoadMore: () => loadMessages(true),
  onClose: closeDetail,
  onCompose: () => openCompose(selectedMailbox()),
});
bindCompose(sendMessage);
bindSearch({
  onSearch: applySearch,
  onClear: () => applySearch(EMPTY_SEARCH_FILTERS),
});

await start();

async function start() {
  try {
    state.session = await getSession();
    const firstMailbox = state.session.mailboxes[0];
    selectMailbox(firstMailbox?.id || '');
    renderSession(state.session, state.mailboxId);
    renderFolder(state.folder);
    renderSearch(state.searchFilters);
    if (!firstMailbox) {
      renderMessageList(state, openMessage);
      showStatus('このAccess identityにはメールボックスが割り当てられていません。', true);
      return;
    }
    await loadMessages(false);
  } catch (error) {
    handleError(error, 'Webメールを開始できませんでした。');
  }
}

async function changeMailbox(mailboxId) {
  if (!mailboxId || mailboxId === state.mailboxId) return;
  selectMailbox(mailboxId);
  renderSession(state.session, state.mailboxId);
  closeMessageDetail();
  await loadMessages(false);
}

async function changeFolder(folder) {
  if (!folder || folder === state.folder) return;
  selectFolder(folder);
  renderFolder(folder);
  closeMessageDetail();
  await loadMessages(false);
}

async function loadMessages(append) {
  if (!state.mailboxId) return;
  const revision = state.revision;
  state.activeLoads += 1;
  state.busy = true;
  setMessageListBusy(true);
  try {
    const page = await getMessages(
      state.mailboxId,
      state.folder,
      append ? state.nextCursor : null,
      state.searchFilters,
    );
    if (revision !== state.revision) return;
    if (append) appendMessagePage(page);
    else replaceMessagePage(page);
    renderMessageList(state, openMessage);
  } catch (error) {
    if (revision === state.revision) {
      handleError(error, 'メール一覧を取得できませんでした。');
    }
  } finally {
    state.activeLoads -= 1;
    state.busy = state.activeLoads > 0;
    setMessageListBusy(state.busy);
  }
}

async function applySearch(filters) {
  setSearchFilters(filters);
  closeMessageDetail();
  renderSearch(state.searchFilters);
  await loadMessages(false);
  if (state.messages.length === 0 && hasActiveSearch(state.searchFilters)) {
    showStatus('検索条件に一致するメールはありません。');
  }
}

async function openMessage(messageId) {
  state.selectedMessageId = messageId;
  renderMessageList(state, openMessage);
  showDetailLoading();
  try {
    const detail = await getMessage(messageId);
    const body = await getMessageBody(detail.message);
    if (state.selectedMessageId !== messageId) return;
    showMessageDetail(detail, body, (patch) => applyPatch(messageId, patch));
  } catch (error) {
    handleError(error, 'メッセージを取得できませんでした。');
    closeDetail();
  }
}

async function applyPatch(messageId, patch) {
  try {
    await patchMessage(messageId, patch);
    showStatus('メッセージを更新しました。');
    await loadMessages(false);
    if (state.messages.some((message) => message.id === messageId)) {
      await openMessage(messageId);
    } else {
      closeDetail();
    }
  } catch (error) {
    handleError(error, 'メッセージを更新できませんでした。');
  }
}

async function sendMessage(input) {
  try {
    await createMessage(state.mailboxId, input);
    showStatus('メールを送信トレイに追加しました。');
    await changeFolder('outbox');
  } catch (error) {
    handleError(error, 'メールを送信トレイへ追加できませんでした。');
    throw error;
  }
}

function selectedMailbox() {
  return state.session?.mailboxes.find((mailbox) => mailbox.id === state.mailboxId);
}

function closeDetail() {
  state.selectedMessageId = '';
  closeMessageDetail();
  renderMessageList(state, openMessage);
}

function handleError(error, fallback) {
  const suffix = typeof error?.code === 'string' ? ` (${error.code})` : '';
  showStatus(`${fallback}${suffix}`, true);
}
