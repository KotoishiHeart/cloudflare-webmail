import { FOLDER_LABELS } from './format.js';

const mailboxSelect = document.querySelector('#mailbox-select');
const folderTitle = document.querySelector('#folder-title');
const status = document.querySelector('#status');
let statusTimer;

export function renderSession(session, selectedMailboxId) {
  document.querySelector('#identity-email').textContent = session.user.email;
  document.querySelector('#admin-button').hidden = !session.user.isSystemAdmin;
  mailboxSelect.replaceChildren();
  for (const mailbox of session.mailboxes) {
    const option = document.createElement('option');
    option.value = mailbox.id;
    option.textContent = mailbox.displayName === mailbox.address
      ? mailbox.address
      : `${mailbox.displayName} — ${mailbox.address}`;
    option.selected = mailbox.id === selectedMailboxId;
    mailboxSelect.append(option);
  }
  mailboxSelect.disabled = session.mailboxes.length < 2;
  const selected = session.mailboxes.find((mailbox) => mailbox.id === selectedMailboxId);
  const compose = document.querySelector('#compose-button');
  compose.disabled = !selected || selected.role === 'viewer';
  compose.title = compose.disabled ? 'このメールボックスは閲覧専用です' : '';
}

export function renderFolder(folder) {
  folderTitle.textContent = FOLDER_LABELS[folder] || 'メール';
  for (const button of document.querySelectorAll('[data-folder]')) {
    button.classList.toggle('active', button.dataset.folder === folder);
  }
}

export function showStatus(message, error = false, action = null) {
  window.clearTimeout(statusTimer);
  status.replaceChildren(document.createTextNode(message));
  status.classList.toggle('error', error);
  status.setAttribute('role', error ? 'alert' : 'status');
  status.setAttribute('aria-live', error ? 'assertive' : 'polite');
  status.hidden = false;
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', async () => {
      button.disabled = true;
      await action.activate();
    }, { once: true });
    status.append(button);
  }
  statusTimer = window.setTimeout(() => {
    status.hidden = true;
  }, error ? 7000 : action ? 7000 : 3500);
}

export function bindShell({ onMailbox, onFolder, onRefresh, onLoadMore, onClose, onCompose, onSettings }) {
  mailboxSelect.addEventListener('change', () => onMailbox(mailboxSelect.value));
  document.querySelector('#folder-nav').addEventListener('click', (event) => {
    const button = event.target.closest('[data-folder]');
    if (button) onFolder(button.dataset.folder);
  });
  document.querySelector('#refresh-button').addEventListener('click', onRefresh);
  document.querySelector('#load-more').addEventListener('click', onLoadMore);
  document.querySelector('#detail-close').addEventListener('click', onClose);
  document.querySelector('#compose-button').addEventListener('click', onCompose);
  document.querySelector('#settings-button').addEventListener('click', onSettings);
}
