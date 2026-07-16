import { adminApi } from './ui/admin-api.js';
import { bindAdminEvents, loadAdminEvents } from './ui/admin-events.js';
import { clear, element } from './ui/admin-dom.js';
import { bindAdminMailboxes, renderAdminMailboxes } from './ui/admin-mailboxes.js';
import { bindAdminRetention, loadAdminRetention, renderRetentionMailboxes } from './ui/admin-retention.js';
import { bindAdminUsers, renderAdminUsers } from './ui/admin-users.js';
import { registerServiceWorker } from './ui/pwa.js';

const state = { users: [], mailboxes: [], section: 'overview' };
let statusTimer;

bindAdminUsers({ changed: reloadDirectory, status: showStatus, error: handleError });
bindAdminMailboxes({ changed: reloadDirectory, status: showStatus, error: handleError });
bindAdminEvents({ error: handleError });
bindAdminRetention({ status: showStatus, error: handleError });
bindNavigation();
registerServiceWorker();
await start();

async function start() {
  try {
    const session = await adminApi.session();
    document.querySelector('#admin-email').textContent = session.user.email;
    if (!session.user.isSystemAdmin) {
      document.querySelector('#admin-loading').hidden = true;
      document.querySelector('#admin-denied').hidden = false;
      document.querySelector('.admin-nav').hidden = true;
      return;
    }
    await reloadDirectory();
    document.querySelector('#admin-loading').hidden = true;
    showSection('overview');
  } catch (error) {
    document.querySelector('#admin-loading').hidden = true;
    handleError(error, '管理コンソールを開始できませんでした。');
  }
}

async function reloadDirectory() {
  const [summaryData, userData, mailboxData] = await Promise.all([
    adminApi.summary(), adminApi.users(), adminApi.mailboxes(),
  ]);
  state.users = userData.users;
  state.mailboxes = mailboxData.mailboxes;
  renderSummary(summaryData.summary);
  renderAdminUsers(state.users);
  renderAdminMailboxes(state.mailboxes, state.users);
  renderRetentionMailboxes(state.mailboxes);
}

function renderSummary(summary) {
  const cards = clear(document.querySelector('#summary-cards'));
  const metrics = [
    ['有効ユーザー', summary.active_users],
    ['有効管理者', summary.active_administrators],
    ['有効メールボックス', summary.active_mailboxes],
    ['有効アドレス', summary.active_addresses],
    ['保存メール', summary.messages],
    ['7日間の配送失敗', summary.failed_delivery_events_7d],
  ];
  for (const [label, value] of metrics) {
    cards.append(element('div', { className: 'summary-card' }, [
      element('strong', { text: value ?? 0 }),
      element('span', { text: label }),
    ]));
  }
}

function bindNavigation() {
  document.querySelector('.admin-nav').addEventListener('click', (event) => {
    const button = event.target.closest('[data-admin-section]');
    if (button) showSection(button.dataset.adminSection);
  });
}

async function showSection(name) {
  state.section = name;
  for (const section of document.querySelectorAll('.admin-section')) {
    section.hidden = section.id !== `admin-${name}`;
  }
  for (const button of document.querySelectorAll('[data-admin-section]')) {
    button.classList.toggle('active', button.dataset.adminSection === name);
    button.setAttribute('aria-current', button.dataset.adminSection === name ? 'page' : 'false');
  }
  if (name === 'events') await loadAdminEvents();
  if (name === 'retention') await loadAdminRetention();
  document.querySelector('#admin-main').focus({ preventScroll: true });
}

function showStatus(message, error = false) {
  const status = document.querySelector('#admin-status');
  window.clearTimeout(statusTimer);
  status.textContent = message;
  status.classList.toggle('error', error);
  status.setAttribute('role', error ? 'alert' : 'status');
  status.setAttribute('aria-live', error ? 'assertive' : 'polite');
  status.hidden = false;
  statusTimer = window.setTimeout(() => { status.hidden = true; }, error ? 7000 : 4000);
}

function handleError(error, fallback) {
  const suffix = typeof error?.code === 'string' ? ` (${error.code})` : '';
  showStatus(`${fallback}${suffix}`, true);
}
