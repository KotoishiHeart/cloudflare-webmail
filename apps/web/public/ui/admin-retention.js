import { adminApi } from './admin-api.js';
import { button, clear, dateTime, element, formValues, statusPill } from './admin-dom.js';

let callbacks;
let mailboxId = '';
let selectedRunId = '';

export function bindAdminRetention(options) {
  callbacks = options;
  document.querySelector('#retention-mailbox').addEventListener('change', (event) => {
    mailboxId = event.currentTarget.value;
    selectedRunId = '';
    loadAdminRetention();
  });
  document.querySelector('#retention-policy').addEventListener('submit', savePolicy);
  document.querySelector('#retention-preview').addEventListener('submit', createPreview);
}

export function renderRetentionMailboxes(mailboxes) {
  const select = clear(document.querySelector('#retention-mailbox'));
  for (const mailbox of mailboxes) {
    select.append(element('option', {
      text: mailbox.primaryAddress || mailbox.displayName,
      attributes: { value: mailbox.id },
    }));
  }
  if (!mailboxes.some((mailbox) => mailbox.id === mailboxId)) mailboxId = mailboxes[0]?.id || '';
  select.value = mailboxId;
  select.disabled = mailboxes.length === 0;
}

export async function loadAdminRetention() {
  if (!mailboxId) return;
  await perform(async () => {
    const [policyData, runData] = await Promise.all([
      adminApi.retentionPolicy(mailboxId),
      adminApi.retentionRuns(mailboxId),
    ]);
    renderPolicy(policyData.policy);
    renderRuns(runData.runs);
    if (selectedRunId) await showRun(selectedRunId);
  }, '保持情報を取得できませんでした。');
}

function renderPolicy(policy) {
  const form = document.querySelector('#retention-policy');
  form.elements.retentionDays.value = policy.retentionDays;
  form.elements.excludeStarred.checked = policy.excludeStarred;
  form.elements.excludeLabeled.checked = policy.excludeLabeled;
  form.elements.enabled.checked = policy.enabled;
}

function renderRuns(runs) {
  const list = clear(document.querySelector('#retention-run-list'));
  if (runs.length === 0) {
    list.append(element('p', { className: 'muted', text: '保持runはありません。' }));
    return;
  }
  for (const run of runs) {
    const title = element('strong', { text: `preview ${dateTime(run.createdAt)}` });
    title.append(statusPill(run.status));
    list.append(element('article', { className: 'admin-row' }, [
      element('div', {}, [
        title,
        element('small', {
          text: `${run.candidateCount} candidates · ${run.completedCount} deleted · ${run.skippedCount} skipped · ${run.failedCount} failed`,
        }),
      ]),
      button('詳細', () => showRun(run.id)),
    ]));
  }
}

async function savePolicy(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.elements.enabled.checked && !confirm('この保持ポリシーを有効化しますか？有効化だけでは削除されません。')) return;
  await perform(async () => {
    await adminApi.saveRetentionPolicy(mailboxId, {
      retentionDays: Number(form.elements.retentionDays.value),
      excludeStarred: form.elements.excludeStarred.checked,
      excludeLabeled: form.elements.excludeLabeled.checked,
      enabled: form.elements.enabled.checked,
    });
    callbacks.status('保持ポリシーを保存しました。');
    await loadAdminRetention();
  }, '保持ポリシーを保存できませんでした。');
}

async function createPreview(event) {
  event.preventDefault();
  const limit = Number(formValues(event.currentTarget).limit);
  await perform(async () => {
    const data = await adminApi.createRetentionPreview(mailboxId, { limit });
    selectedRunId = data.run.id;
    callbacks.status(`${data.run.candidateCount}件の候補を固定しました。`);
    await loadAdminRetention();
  }, '保持previewを作成できませんでした。');
}

async function showRun(runId) {
  selectedRunId = runId;
  await perform(async () => {
    const detail = await adminApi.retentionRun(runId);
    renderRunDetail(detail);
  }, '保持run詳細を取得できませんでした。');
}

function renderRunDetail(detail) {
  const container = clear(document.querySelector('#retention-run-detail'));
  container.hidden = false;
  const run = detail.run;
  const title = element('h2', { text: `Retention run ${run.id}` });
  title.append(statusPill(run.status));
  container.append(
    title,
    element('p', {
      className: 'muted',
      text: `cutoff ${dateTime(run.cutoffAt)} · ${run.candidateCount} candidates · ${run.candidateBytes} bytes`,
    }),
  );
  if (run.status === 'preview' && run.candidateCount > 0) {
    container.append(approvalForm(run));
  }
  if (run.status === 'preview' || run.status === 'approved') {
    container.append(button('このrunをキャンセル', () => cancelRun(run.id), 'danger'));
  }
  container.append(element('h3', { text: '候補・処理結果' }));
  for (const item of detail.items) {
    const itemTitle = element('strong', { text: item.subjectSnapshot || '(件名なし)' });
    itemTitle.append(statusPill(item.status));
    container.append(element('div', { className: 'admin-row' }, [
      element('div', {}, [
        itemTitle,
        element('small', {
          text: `${item.messageId} · trash ${dateTime(item.deletedAt)} · ${item.objectKeys.length} objects`,
        }),
      ]),
    ]));
  }
}

function approvalForm(run) {
  const form = element('form', { className: 'admin-card admin-form' }, [
    element('h3', { text: '検証済みバックアップで承認' }),
    labeledInput('backupReference', 'text', 'バックアップ参照', true),
    labeledInput('backupManifestSha256', 'text', 'manifest SHA-256', true),
    labeledInput('backupCreatedAt', 'datetime-local', 'バックアップ作成日時', true),
    labeledInput('confirmation', 'text', '確認文字列: BACKUP_VERIFIED', true),
    element('button', { text: 'このpreviewを完全削除へ承認', className: 'danger', attributes: { type: 'submit' } }),
  ]);
  form.addEventListener('submit', (event) => approveRun(event, run.id));
  return form;
}

async function approveRun(event, runId) {
  event.preventDefault();
  const values = formValues(event.currentTarget);
  if (!confirm('この固定previewを完全削除Jobsへ渡しますか？この操作は取り消せません。')) return;
  const createdAt = new Date(values.backupCreatedAt).getTime();
  await perform(async () => {
    await adminApi.approveRetentionRun(runId, {
      backupReference: values.backupReference,
      backupManifestSha256: values.backupManifestSha256,
      backupCreatedAt: createdAt,
      confirmation: values.confirmation,
    });
    callbacks.status('保持runを承認しました。Jobsが小分けに処理します。');
    await loadAdminRetention();
  }, '保持runを承認できませんでした。');
}

async function cancelRun(runId) {
  if (!confirm('この保持runをキャンセルしますか？')) return;
  await perform(async () => {
    await adminApi.cancelRetentionRun(runId);
    callbacks.status('保持runをキャンセルしました。');
    await loadAdminRetention();
  }, '保持runをキャンセルできませんでした。');
}

function labeledInput(name, type, label, required) {
  return element('label', {}, [
    document.createTextNode(label),
    element('input', { attributes: { name, type, required } }),
  ]);
}

async function perform(operation, fallback) {
  try {
    await operation();
  } catch (error) {
    callbacks.error(error, fallback);
  }
}
