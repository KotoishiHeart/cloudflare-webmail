import {
  createLabel,
  deleteLabel,
  getLabels,
  getMessage,
  getMessageBody,
  getMessages,
  getPreferences,
  getSession,
  patchPreferences,
  patchMessage,
  createMessage,
  putMessageLabels,
} from './ui/api.js';
import {
  bindCompose,
  openCompose,
  openForwardCompose,
  openReplyCompose,
} from './ui/compose.js';
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
  renderLabelFilter,
  renderSearch,
} from './ui/search.js';
import {
  applyPreferences,
  bindSettingsLabels,
  openSettings,
  renderManagedLabels,
} from './ui/settings-labels.js';
import {
  appendMessagePage,
  replaceMessagePage,
  selectFolder,
  selectMailbox,
  setLabels,
  setPreferences,
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
  onSettings: () => openSettings(selectedMailbox(), state.preferences, state.labels),
});
bindCompose(sendMessage);
bindSearch({
  onSearch: applySearch,
  onClear: () => applySearch(EMPTY_SEARCH_FILTERS),
});
bindSettingsLabels({
  onPreferences: savePreferences,
  onCreateLabel: addLabel,
  onDeleteLabel: removeLabel,
});

await start();

async function start() {
  try {
    state.session = await getSession();
    const preferenceData = await getPreferences();
    setPreferences(preferenceData.preferences);
    applyPreferences(state.preferences);
    selectFolder(state.preferences.defaultFolder);
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
    await loadLabels();
    await loadMessages(false);
  } catch (error) {
    handleError(error, 'Webメールを開始できませんでした。');
  }
}

async function changeMailbox(mailboxId) {
  if (!mailboxId || mailboxId === state.mailboxId) return;
  try {
    selectMailbox(mailboxId);
    setSearchFilters({ ...state.searchFilters, label: '' });
    renderSession(state.session, state.mailboxId);
    renderSearch(state.searchFilters);
    closeMessageDetail();
    await loadLabels();
    await loadMessages(false);
  } catch (error) {
    handleError(error, 'メールボックスを切り替えられませんでした。');
  }
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
      state.preferences.pageSize,
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
    showMessageDetail(detail, body, {
      onPatch: (patch) => applyPatch(messageId, patch),
      onReply: () => openReplyCompose(selectedMailbox(), detail, body),
      onForward: () => openForwardCompose(selectedMailbox(), detail, body),
      onLabels: (labelIds) => saveMessageLabels(messageId, labelIds),
      availableLabels: state.labels,
      showHtmlByDefault: state.preferences.showHtmlByDefault,
    });
  } catch (error) {
    handleError(error, 'メッセージを取得できませんでした。');
    closeDetail();
  }
}

async function loadLabels() {
  if (!state.mailboxId) {
    setLabels([]);
    renderLabelFilter([]);
    return;
  }
  const data = await getLabels(state.mailboxId);
  setLabels(data.labels);
  if (state.searchFilters.label
    && !state.labels.some((label) => label.id === state.searchFilters.label)) {
    setSearchFilters({ ...state.searchFilters, label: '' });
    renderSearch(state.searchFilters);
  }
  renderLabelFilter(state.labels);
}

async function saveMessageLabels(messageId, labelIds) {
  try {
    await putMessageLabels(messageId, labelIds);
    showStatus('ラベルを更新しました。');
    await loadLabels();
    await loadMessages(false);
    if (state.messages.some((message) => message.id === messageId)) await openMessage(messageId);
    else closeDetail();
  } catch (error) {
    handleError(error, 'ラベルを更新できませんでした。');
    throw error;
  }
}

async function savePreferences(preferences) {
  try {
    const data = await patchPreferences(preferences);
    setPreferences(data.preferences);
    applyPreferences(state.preferences);
    showStatus('表示設定を保存しました。');
    await loadMessages(false);
  } catch (error) {
    handleError(error, '表示設定を保存できませんでした。');
    throw error;
  }
}

async function addLabel(input) {
  try {
    await createLabel(state.mailboxId, input);
    await loadLabels();
    renderManagedLabels(state.labels);
    showStatus('ラベルを作成しました。');
  } catch (error) {
    handleError(error, 'ラベルを作成できませんでした。');
    throw error;
  }
}

async function removeLabel(labelId) {
  try {
    await deleteLabel(state.mailboxId, labelId);
    await loadLabels();
    renderManagedLabels(state.labels);
    await loadMessages(false);
    showStatus('ラベルを削除しました。');
  } catch (error) {
    handleError(error, 'ラベルを削除できませんでした。');
    throw error;
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
