import {
  applyRuleRun,
  createRule,
  deleteRule,
  getRuleRun,
  getRuleRuns,
  getRules,
  patchRule,
  previewRule,
  undoRuleRun,
} from './api.js';
import {
  bindSettingsRules,
  hideRulePreview,
  renderRuleManager,
  showRulePreview,
} from './settings-rules.js';
import { setRules, state } from './state.js';

let callbacks;

export function bindRuleController(input) {
  callbacks = input;
  bindSettingsRules({
    onCreate: addRule,
    onToggle: toggleRule,
    onDelete: removeRule,
    onPreview: createPreview,
    onOpenRun: openRun,
    onApply: applyPreview,
    onUndo: undoRun,
  });
}

export async function openMailboxRuleManager(mailbox) {
  renderRuleManager(mailbox, state.rules, state.ruleRuns, state.labels);
  if (mailbox?.role !== 'owner') return;
  try {
    await reloadRules();
  } catch (error) {
    callbacks.onError(error, 'ルールを取得できませんでした。');
  }
}

async function reloadRules() {
  const [ruleData, runData] = await Promise.all([
    getRules(state.mailboxId),
    getRuleRuns(state.mailboxId),
  ]);
  setRules(ruleData.rules, runData.runs);
  renderRuleManager(callbacks.getMailbox(), state.rules, state.ruleRuns, state.labels);
}

async function addRule(input) {
  return perform(async () => {
    await createRule(state.mailboxId, input);
    hideRulePreview();
    await reloadRules();
    callbacks.onStatus('ルールを作成しました。');
  }, 'ルールを作成できませんでした。');
}

async function toggleRule(rule) {
  return perform(async () => {
    await patchRule(state.mailboxId, rule.id, { enabled: !rule.enabled });
    hideRulePreview();
    await reloadRules();
    callbacks.onStatus(rule.enabled ? 'ルールを無効化しました。' : 'ルールを有効化しました。');
  }, 'ルールを更新できませんでした。');
}

async function removeRule(ruleId) {
  return perform(async () => {
    await deleteRule(state.mailboxId, ruleId);
    hideRulePreview();
    await reloadRules();
    callbacks.onStatus('ルールを削除しました。');
  }, 'ルールを削除できませんでした。');
}

async function createPreview(ruleId) {
  return perform(async () => {
    const data = await previewRule(state.mailboxId, ruleId);
    await reloadRules();
    showRulePreview(data);
    callbacks.onStatus(`${data.run.matchedCount}件をプレビューしました。`);
  }, 'ルールをプレビューできませんでした。');
}

async function openRun(runId) {
  return perform(async () => showRulePreview(await getRuleRun(state.mailboxId, runId)),
    'プレビュー内容を取得できませんでした。');
}

async function applyPreview(runId) {
  return perform(async () => {
    const data = await applyRuleRun(state.mailboxId, runId);
    hideRulePreview();
    await callbacks.onMessagesChanged();
    await reloadRules();
    callbacks.onStatus(`${data.run.changedCount}件にルールを適用しました。`);
  }, 'プレビューを適用できませんでした。');
}

async function undoRun(runId) {
  return perform(async () => {
    const data = await undoRuleRun(state.mailboxId, runId);
    hideRulePreview();
    await callbacks.onMessagesChanged();
    await reloadRules();
    callbacks.onStatus(`${data.run.changedCount}件のルール変更を取り消しました。`);
  }, 'ルール実行を取り消せませんでした。');
}

async function perform(operation, fallback) {
  try {
    return await operation();
  } catch (error) {
    callbacks.onError(error, fallback);
    throw error;
  }
}
