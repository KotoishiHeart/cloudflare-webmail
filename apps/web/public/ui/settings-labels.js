const dialog = document.querySelector('#settings-dialog');
const preferencesForm = document.querySelector('#preferences-form');
const labelForm = document.querySelector('#label-create-form');
const labelList = document.querySelector('#label-manager-list');
const labelNote = document.querySelector('#label-manager-note');
let handlers;
let mailbox;

export function bindSettingsLabels(callbacks) {
  handlers = callbacks;
  document.querySelector('#settings-close').addEventListener('click', closeSettings);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeSettings();
  });
  preferencesForm.addEventListener('submit', savePreferences);
  labelForm.addEventListener('submit', createLabel);
}

export function openSettings(currentMailbox, mailboxes, preferences, labels) {
  mailbox = currentMailbox;
  renderDefaultMailboxes(mailboxes);
  setPreferenceValues(preferences);
  renderManagedLabels(labels);
  dialog.showModal();
}

export function closeSettings() {
  if (dialog.open) dialog.close();
}

export function renderManagedLabels(labels) {
  labelList.replaceChildren();
  const canManage = mailbox?.role === 'owner';
  labelForm.hidden = !canManage;
  labelNote.textContent = canManage
    ? 'ラベルはこのメールボックスの全メンバーに共有されます。'
    : 'ラベルの作成・削除はメールボックス所有者だけが行えます。';
  if (labels.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'ラベルはまだありません。';
    labelList.append(empty);
    return;
  }
  for (const label of labels) {
    const row = document.createElement('div');
    row.className = 'label-manager-row';
    const swatch = document.createElement('span');
    swatch.className = 'label-swatch';
    swatch.style.backgroundColor = label.color;
    const text = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = label.name;
    const meta = document.createElement('small');
    meta.textContent = `${label.messageCount}件${label.description ? ` · ${label.description}` : ''}`;
    text.append(name, meta);
    row.append(swatch, text);
    if (canManage) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger';
      remove.textContent = '削除';
      remove.addEventListener('click', () => removeLabel(label));
      row.append(remove);
    }
    labelList.append(row);
  }
}

export function applyPreferences(preferences) {
  document.documentElement.dataset.theme = preferences.theme;
  document.body.classList.toggle('compact-layout', preferences.compactLayout);
}

async function savePreferences(event) {
  event.preventDefault();
  const data = new FormData(preferencesForm);
  const submit = preferencesForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await handlers.onPreferences({
      theme: String(data.get('theme')),
      pageSize: Number(data.get('pageSize')),
      defaultFolder: String(data.get('defaultFolder')),
      defaultMailboxId: String(data.get('defaultMailboxId') || '') || null,
      showHtmlByDefault: data.get('showHtmlByDefault') !== null,
      compactLayout: data.get('compactLayout') !== null,
    });
  } catch {
    // The application callback presents the API error in the shared status area.
  } finally {
    submit.disabled = false;
  }
}

async function createLabel(event) {
  event.preventDefault();
  const data = new FormData(labelForm);
  const submit = labelForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await handlers.onCreateLabel({
      name: String(data.get('name') || ''),
      color: String(data.get('color') || '#64748b'),
      description: String(data.get('description') || ''),
    });
    labelForm.reset();
    labelForm.elements.namedItem('color').value = '#64748b';
  } catch {
    // Preserve the draft so the owner can correct it and retry.
  } finally {
    submit.disabled = false;
  }
}

async function removeLabel(label) {
  if (!window.confirm(`ラベル「${label.name}」を削除しますか？`)) return;
  try {
    await handlers.onDeleteLabel(label.id);
  } catch {
    // The application callback presents the API error in the shared status area.
  }
}

function setPreferenceValues(preferences) {
  for (const name of ['theme', 'pageSize', 'defaultFolder']) {
    preferencesForm.elements.namedItem(name).value = String(preferences[name]);
  }
  preferencesForm.elements.namedItem('defaultMailboxId').value = preferences.defaultMailboxId || '';
  preferencesForm.elements.namedItem('showHtmlByDefault').checked = preferences.showHtmlByDefault;
  preferencesForm.elements.namedItem('compactLayout').checked = preferences.compactLayout;
}

function renderDefaultMailboxes(mailboxes) {
  const select = preferencesForm.elements.namedItem('defaultMailboxId');
  select.replaceChildren(new Option('先頭の利用可能なメールボックス', ''));
  for (const item of mailboxes) {
    select.add(new Option(`${item.displayName} — ${item.address}`, item.id));
  }
}
