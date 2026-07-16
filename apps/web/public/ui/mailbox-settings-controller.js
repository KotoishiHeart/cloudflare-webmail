import {
  createLabel,
  deleteLabel,
  getLabels,
  patchPreferences,
  putMessageLabels,
} from './api.js';
import { openMailboxRuleManager } from './rule-controller.js';
import {
  applyPreferences,
  openSettings,
  renderManagedLabels,
} from './settings-labels.js';
import {
  setLabels,
  setPreferences,
  setSearchFilters,
  state,
} from './state.js';
import { renderLabelFilter, renderSearch } from './search.js';

export function createMailboxSettingsController(dependencies) {
  return {
    applyPreferences,
    loadLabels,
    saveMessageLabels,
    savePreferences,
    addLabel,
    removeLabel,
    openSettingsPanel,
    refreshAfterRuleMutation,
  };

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
      dependencies.status('ラベルを更新しました。');
      await loadLabels();
      await dependencies.loadMessages(false);
      if (state.messages.some((message) => message.id === messageId)) {
        await dependencies.openMessage(messageId);
      } else dependencies.closeDetail();
    } catch (error) {
      dependencies.error(error, 'ラベルを更新できませんでした。');
      throw error;
    }
  }

  async function savePreferences(preferences) {
    try {
      const data = await patchPreferences(preferences);
      setPreferences(data.preferences);
      applyPreferences(state.preferences);
      dependencies.status('表示設定を保存しました。');
      await dependencies.loadMessages(false);
    } catch (error) {
      dependencies.error(error, '表示設定を保存できませんでした。');
      throw error;
    }
  }

  async function addLabel(input) {
    try {
      await createLabel(state.mailboxId, input);
      await loadLabels();
      renderManagedLabels(state.labels);
      dependencies.status('ラベルを作成しました。');
    } catch (error) {
      dependencies.error(error, 'ラベルを作成できませんでした。');
      throw error;
    }
  }

  async function removeLabel(labelId) {
    try {
      await deleteLabel(state.mailboxId, labelId);
      await loadLabels();
      renderManagedLabels(state.labels);
      await dependencies.loadMessages(false);
      dependencies.status('ラベルを削除しました。');
    } catch (error) {
      dependencies.error(error, 'ラベルを削除できませんでした。');
      throw error;
    }
  }

  async function openSettingsPanel() {
    const mailbox = dependencies.selectedMailbox();
    openSettings(mailbox, state.preferences, state.labels);
    await openMailboxRuleManager(mailbox);
  }

  async function refreshAfterRuleMutation() {
    await loadLabels();
    renderManagedLabels(state.labels);
    await dependencies.loadMessages(false);
    if (state.selectedMessageId
      && state.messages.some((message) => message.id === state.selectedMessageId)) {
      await dependencies.openMessage(state.selectedMessageId);
    } else if (state.selectedMessageId) dependencies.closeDetail();
  }
}
