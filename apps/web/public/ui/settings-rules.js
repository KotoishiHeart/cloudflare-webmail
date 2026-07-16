import { formatBytes, fullDate } from './format.js';

const section = document.querySelector('#rule-manager');
const form = document.querySelector('#rule-create-form');
const ruleList = document.querySelector('#rule-manager-list');
const runList = document.querySelector('#rule-run-list');
const preview = document.querySelector('#rule-preview');
const previewApply = document.querySelector('#rule-preview-apply');
let handlers;
let currentRules = [];
let previewRunId = '';

export function bindSettingsRules(callbacks) {
  handlers = callbacks;
  form.addEventListener('submit', submitRule);
  previewApply.addEventListener('click', async () => {
    if (!previewRunId || !window.confirm('表示中の固定プレビューへルールを適用しますか？')) return;
    await safeAction(() => handlers.onApply(previewRunId), previewApply);
  });
}

export function renderRuleManager(mailbox, rules, runs, labels) {
  const canManage = mailbox?.role === 'owner';
  section.hidden = !canManage;
  if (!canManage) return;
  currentRules = rules;
  renderRuleLabels(labels);
  renderRules(rules);
  renderRuns(runs);
}

export function showRulePreview({ run, matches }) {
  previewRunId = run.id;
  preview.hidden = false;
  const rule = currentRules.find((item) => item.id === run.ruleId);
  const canApply = run.status === 'ready'
    && rule?.applyExisting === true
    && rule.revision === run.ruleVersion;
  document.querySelector('#rule-preview-title').textContent =
    `${run.ruleName}: ${run.matchedCount}件${canApply ? '' : '（既存適用は無効）'}`;
  previewApply.disabled = !canApply;
  const container = document.querySelector('#rule-preview-matches');
  container.replaceChildren();
  if (matches.length === 0) {
    container.textContent = '一致するメールはありません。';
    return;
  }
  for (const message of matches) {
    const row = document.createElement('div');
    row.className = 'rule-preview-row';
    const title = document.createElement('strong');
    title.textContent = message.subject || '（件名なし）';
    const meta = document.createElement('small');
    meta.textContent = `${message.sender || '差出人不明'} · ${fullDate(message.receivedAt)} · ${formatBytes(message.rawSize)}`;
    row.append(title, meta);
    container.append(row);
  }
}

export function hideRulePreview() {
  previewRunId = '';
  preview.hidden = true;
}

async function submitRule(event) {
  event.preventDefault();
  const input = ruleDefinition(new FormData(form));
  if (input === null) return;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await handlers.onCreate(input);
    form.reset();
    form.elements.namedItem('priority').value = '100';
    form.elements.namedItem('enabled').checked = true;
    form.elements.namedItem('applyIncoming').checked = true;
  } catch {
    // Preserve the draft when API validation fails.
  } finally {
    submit.disabled = false;
  }
}

function renderRuleLabels(labels) {
  const select = document.querySelector('#rule-label-ids');
  select.replaceChildren();
  for (const label of labels) select.add(new Option(label.name, label.id));
}

function renderRules(rules) {
  ruleList.replaceChildren();
  if (rules.length === 0) {
    ruleList.append(empty('ルールはまだありません。'));
    return;
  }
  for (const rule of rules) {
    const row = document.createElement('article');
    row.className = 'rule-row';
    const body = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = `${rule.enabled ? '●' : '○'} ${rule.priority} · ${rule.name}`;
    const conditions = document.createElement('small');
    conditions.textContent = conditionSummary(rule.conditions);
    const actions = document.createElement('small');
    actions.textContent = `${actionSummary(rule.actions)} · 新規:${rule.applyIncoming ? '有効' : '無効'} / 既存:${rule.applyExisting ? '可能' : '不可'}`;
    body.append(name, conditions, actions);
    const controls = document.createElement('div');
    controls.className = 'rule-row-actions';
    controls.append(
      actionButton(rule.enabled ? '無効化' : '有効化', () => handlers.onToggle(rule)),
      actionButton('プレビュー', () => handlers.onPreview(rule.id)),
      actionButton('削除', () => removeRule(rule), 'danger'),
    );
    row.append(body, controls);
    ruleList.append(row);
  }
}

function renderRuns(runs) {
  runList.replaceChildren();
  if (runs.length === 0) {
    runList.append(empty('実行履歴はまだありません。'));
    return;
  }
  for (const run of runs) {
    const row = document.createElement('article');
    row.className = 'rule-run-row';
    const body = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${run.mode} · ${run.status} · ${run.ruleName}`;
    const detail = document.createElement('small');
    detail.textContent = `${fullDate(run.createdAt)} · 一致${run.matchedCount} / 変更${run.changedCount} · ${run.summary}`;
    body.append(title, detail);
    const controls = document.createElement('div');
    controls.className = 'rule-row-actions';
    if (run.mode === 'preview') {
      controls.append(actionButton('内容', () => handlers.onOpenRun(run.id)));
    }
    const currentRule = currentRules.find((rule) => rule.id === run.ruleId);
    if (run.mode === 'preview' && run.status === 'ready'
      && currentRule?.applyExisting === true && currentRule.revision === run.ruleVersion) {
      controls.append(actionButton('適用', () => applyRun(run)));
    }
    if (['apply_existing', 'incoming'].includes(run.mode) && run.status === 'completed') {
      controls.append(actionButton('取り消し', () => undoRun(run), 'danger'));
    }
    row.append(body, controls);
    runList.append(row);
  }
}

function actionButton(label, callback, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', () => safeAction(callback, button));
  return button;
}

async function safeAction(callback, button) {
  if (button) button.disabled = true;
  try {
    await callback();
  } catch {
    // The controller reports the error through the shared status area.
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

async function removeRule(rule) {
  if (!window.confirm(`ルール「${rule.name}」を削除しますか？実行履歴は保持されます。`)) return;
  await handlers.onDelete(rule.id);
}

async function undoRun(run) {
  if (!window.confirm(`実行「${run.ruleName}」を取り消しますか？後から行った変更は保持されます。`)) return;
  await handlers.onUndo(run.id);
}

async function applyRun(run) {
  if (!window.confirm(`プレビュー「${run.ruleName}」の${run.matchedCount}件へ適用しますか？`)) return;
  await handlers.onApply(run.id);
}

function ruleDefinition(data) {
  const archive = data.get('archive') !== null;
  const trash = data.get('trash') !== null;
  const labelIds = data.getAll('labelIds').map(String);
  const star = data.get('star') !== null;
  if (!star && !archive && !trash && labelIds.length === 0) {
    window.alert('少なくとも1つのアクションを選択してください。');
    return null;
  }
  if (archive && trash) {
    window.alert('アーカイブとゴミ箱は同時に選択できません。');
    return null;
  }
  return {
    name: String(data.get('name') || ''),
    enabled: data.get('enabled') !== null,
    priority: Number(data.get('priority')),
    conditions: {
      fromContains: String(data.get('fromContains') || ''),
      toContains: String(data.get('toContains') || ''),
      subjectContains: String(data.get('subjectContains') || ''),
      participantDomain: String(data.get('participantDomain') || ''),
      keyword: String(data.get('keyword') || ''),
      attachment: String(data.get('attachment')),
      minimumBytes: kbValue(data.get('minimumKb')),
      maximumBytes: kbValue(data.get('maximumKb')),
      direction: String(data.get('direction')),
    },
    actions: { star, archive, trash, labelIds },
    applyExisting: data.get('applyExisting') !== null,
    applyIncoming: data.get('applyIncoming') !== null,
    stopProcessing: data.get('stopProcessing') !== null,
  };
}

function kbValue(value) {
  return value === null || value === '' ? null : Math.round(Number(value) * 1024);
}

function conditionSummary(value) {
  const parts = [];
  if (value.fromContains) parts.push(`From:${value.fromContains}`);
  if (value.toContains) parts.push(`To:${value.toContains}`);
  if (value.subjectContains) parts.push(`件名:${value.subjectContains}`);
  if (value.participantDomain) parts.push(`ドメイン:${value.participantDomain}`);
  if (value.keyword) parts.push(`語句:${value.keyword}`);
  if (value.attachment !== 'any') parts.push(value.attachment === 'with' ? '添付あり' : '添付なし');
  if (value.minimumBytes !== null) parts.push(`${formatBytes(value.minimumBytes)}以上`);
  if (value.maximumBytes !== null) parts.push(`${formatBytes(value.maximumBytes)}以下`);
  if (value.direction !== 'any') parts.push(value.direction === 'inbound' ? '受信' : '送信');
  return parts.join(' / ') || 'すべてのメール';
}

function actionSummary(value) {
  return [value.star && 'スター', value.archive && 'アーカイブ', value.trash && 'ゴミ箱',
    value.labelIds.length > 0 && `ラベル${value.labelIds.length}個`].filter(Boolean).join(' / ');
}

function empty(text) {
  const element = document.createElement('p');
  element.className = 'muted';
  element.textContent = text;
  return element;
}
