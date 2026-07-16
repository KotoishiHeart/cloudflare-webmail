import {
  getMessage,
  getMessageBody,
  getMessages,
  getPreferences,
  getSession,
  patchMessage,
  patchMessages,
  createMessage,
} from './ui/api.js';
import { createBulkController } from './ui/bulk-controller.js';
import { createMessageActionsController } from './ui/message-actions-controller.js';
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
import { bindRuleController } from './ui/rule-controller.js';
import {
  EMPTY_SEARCH_FILTERS,
  bindSearch,
  hasActiveSearch,
  renderSearch,
} from './ui/search.js';
import {
  bindSettingsLabels,
} from './ui/settings-labels.js';
import {
  appendMessagePage,
  replaceMessagePage,
  selectFolder,
  selectMailbox,
  setPreferences,
  setSearchFilters,
  state,
} from './ui/state.js';
import { bindShell, renderFolder, renderSession, showStatus } from './ui/shell.js';
import { registerServiceWorker } from './ui/pwa.js';
import { createMailboxSettingsController } from './ui/mailbox-settings-controller.js';

const settings = createMailboxSettingsController({
  loadMessages,
  openMessage,
  closeDetail,
  selectedMailbox,
  status: showStatus,
  error: handleError,
});
const bulk = createBulkController({
  state,
  getMailbox: selectedMailbox,
  patchMessages,
  loadMessages,
  status: showStatus,
  error: handleError,
});
const messageActions = createMessageActionsController({
  state, patchMessage, loadMessages, openMessage, closeDetail,
  status: showStatus, error: handleError,
});

bindShell({
  onMailbox: changeMailbox,
  onFolder: changeFolder,
  onRefresh: () => loadMessages(false),
  onLoadMore: () => loadMessages(true),
  onClose: closeDetail,
  onCompose: () => openCompose(selectedMailbox()),
  onSettings: settings.openSettingsPanel,
});
bindCompose(sendMessage);
bindSearch({
  onSearch: applySearch,
  onClear: () => applySearch(EMPTY_SEARCH_FILTERS),
});
bindSettingsLabels({
  onPreferences: settings.savePreferences,
  onCreateLabel: settings.addLabel,
  onDeleteLabel: settings.removeLabel,
});
bindRuleController({
  getMailbox: selectedMailbox,
  onMessagesChanged: settings.refreshAfterRuleMutation,
  onStatus: showStatus,
  onError: handleError,
});
registerServiceWorker();

await start();

async function start() {
  try {
    state.session = await getSession();
    const preferenceData = await getPreferences();
    setPreferences(preferenceData.preferences);
    settings.applyPreferences(state.preferences);
    selectFolder(state.preferences.defaultFolder);
    const firstMailbox = state.session.mailboxes.find(
      (mailbox) => mailbox.id === state.preferences.defaultMailboxId,
    ) || state.session.mailboxes[0];
    selectMailbox(firstMailbox?.id || '');
    renderSession(state.session, state.mailboxId);
    renderFolder(state.folder);
    renderSearch(state.searchFilters);
    if (!firstMailbox) {
      renderCurrentMessages();
      showStatus('このAccess identityにはメールボックスが割り当てられていません。', true);
      return;
    }
    await settings.loadLabels();
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
    await settings.loadLabels();
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
    renderCurrentMessages();
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
  renderCurrentMessages();
  showDetailLoading();
  try {
    const detail = await getMessage(messageId);
    const body = await getMessageBody(detail.message);
    if (state.selectedMessageId !== messageId) return;
    showMessageDetail(detail, body, {
      onPatch: (patch) => messageActions.apply(messageId, patch, detail.message),
      onReply: () => openReplyCompose(selectedMailbox(), detail, body),
      onForward: () => openForwardCompose(selectedMailbox(), detail, body),
      onLabels: (labelIds) => settings.saveMessageLabels(messageId, labelIds),
      availableLabels: state.labels,
      showHtmlByDefault: state.preferences.showHtmlByDefault,
    });
  } catch (error) {
    handleError(error, 'メッセージを取得できませんでした。');
    closeDetail();
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
  renderCurrentMessages();
}

function renderCurrentMessages() {
  const mailbox = selectedMailbox();
  renderMessageList(state, {
    onSelect: openMessage,
    onToggle: bulk.toggle,
    selectable: Boolean(mailbox && mailbox.role !== 'viewer'),
  });
  bulk.render();
}

function handleError(error, fallback) {
  const suffix = typeof error?.code === 'string' ? ` (${error.code})` : '';
  showStatus(`${fallback}${suffix}`, true);
}
