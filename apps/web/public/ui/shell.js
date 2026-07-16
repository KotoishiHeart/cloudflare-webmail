import { FOLDER_LABELS } from './format.js';

const mailboxSelect = document.querySelector('#mailbox-select');
const folderTitle = document.querySelector('#folder-title');
const status = document.querySelector('#status');
let statusTimer;

export function renderSession(session, selectedMailboxId) {
  document.querySelector('#identity-email').textContent = session.user.email;
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
}

export function renderFolder(folder) {
  folderTitle.textContent = FOLDER_LABELS[folder] || 'メール';
  for (const button of document.querySelectorAll('[data-folder]')) {
    button.classList.toggle('active', button.dataset.folder === folder);
  }
}

export function showStatus(message, error = false) {
  window.clearTimeout(statusTimer);
  status.textContent = message;
  status.classList.toggle('error', error);
  status.hidden = false;
  statusTimer = window.setTimeout(() => {
    status.hidden = true;
  }, error ? 7000 : 3500);
}

export function bindShell({ onMailbox, onFolder, onRefresh, onLoadMore, onClose }) {
  mailboxSelect.addEventListener('change', () => onMailbox(mailboxSelect.value));
  document.querySelector('#folder-nav').addEventListener('click', (event) => {
    const button = event.target.closest('[data-folder]');
    if (button) onFolder(button.dataset.folder);
  });
  document.querySelector('#refresh-button').addEventListener('click', onRefresh);
  document.querySelector('#load-more').addEventListener('click', onLoadMore);
  document.querySelector('#detail-close').addEventListener('click', onClose);
}
