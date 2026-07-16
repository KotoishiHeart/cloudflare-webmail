import { adminApi } from './admin-api.js';
import { button, clear, element, formValues, statusPill } from './admin-dom.js';

let callbacks;
let users = [];

export function bindAdminUsers(options) {
  callbacks = options;
  document.querySelector('#admin-user-create').addEventListener('submit', createUser);
}

export function renderAdminUsers(nextUsers) {
  users = nextUsers;
  const list = clear(document.querySelector('#admin-user-list'));
  if (users.length === 0) {
    list.append(element('p', { className: 'muted', text: 'ユーザーはありません。' }));
    return;
  }
  for (const user of users) list.append(userRow(user));
}

function userRow(user) {
  const identity = element('div', {}, [
    element('strong', { text: user.displayName || user.email }),
    element('small', {
      text: `${user.email} · identity ${user.identityCount} · mailbox ${user.mailboxCount}`,
    }),
  ]);
  identity.querySelector('strong').append(
    statusPill(user.status),
    ...(user.isSystemAdmin ? [statusPill('admin')] : []),
  );
  const actions = element('div', { className: 'admin-row-actions' }, [
    button('詳細', () => showUserDetail(user.id)),
    button(
      user.status === 'active' ? '無効化' : '有効化',
      () => setUserStatus(user),
      user.status === 'active' ? 'danger' : '',
    ),
    button(
      user.isSystemAdmin ? '管理者を解除' : '管理者にする',
      () => setAdministrator(user),
      user.isSystemAdmin ? 'danger' : '',
    ),
  ]);
  const row = element('article', { className: 'admin-row' }, [identity, actions]);
  const detail = element('div', { className: 'admin-card admin-detail' });
  detail.hidden = true;
  return element('div', { attributes: { 'data-user-id': user.id } }, [row, detail]);
}

async function createUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formValues(form);
  await perform(async () => {
    await adminApi.createUser({
      email: values.email,
      ...(values.displayName ? { displayName: values.displayName } : {}),
      identity: { issuer: values.issuer, subject: values.subject },
      isSystemAdmin: form.elements.isSystemAdmin.checked,
    });
    form.reset();
    callbacks.status('ユーザーを作成しました。');
    await callbacks.changed();
  }, 'ユーザーを作成できませんでした。');
}

async function setUserStatus(user) {
  const status = user.status === 'active' ? 'disabled' : 'active';
  if (status === 'disabled' && !confirm(`${user.email} を無効化しますか？`)) return;
  await perform(async () => {
    await adminApi.patchUser(user.id, { status });
    callbacks.status(`ユーザーを${status === 'active' ? '有効化' : '無効化'}しました。`);
    await callbacks.changed();
  }, 'ユーザー状態を更新できませんでした。');
}

async function setAdministrator(user) {
  const enabled = !user.isSystemAdmin;
  if (!enabled && !confirm(`${user.email} のシステム管理者権限を解除しますか？`)) return;
  await perform(async () => {
    await adminApi.setAdministrator(user.id, enabled);
    callbacks.status('管理者権限を更新しました。');
    await callbacks.changed();
  }, '管理者権限を更新できませんでした。');
}

async function showUserDetail(userId) {
  const wrapper = document.querySelector(`[data-user-id="${CSS.escape(userId)}"]`);
  if (!wrapper) return;
  const detail = wrapper.querySelector('.admin-detail');
  if (!detail.hidden) {
    detail.hidden = true;
    return;
  }
  await perform(async () => {
    const data = await adminApi.user(userId);
    renderUserDetail(detail, data);
    detail.hidden = false;
  }, 'ユーザー詳細を取得できませんでした。');
}

function renderUserDetail(container, data) {
  clear(container);
  const user = data.user;
  const profile = element('form', { className: 'inline-form' }, [
    input('email', 'email', user.email),
    input('displayName', 'text', user.displayName || '', '表示名', false),
    submit('基本情報を保存'),
  ]);
  profile.addEventListener('submit', (event) => updateProfile(event, user.id));
  container.append(element('h3', { text: '基本情報' }), profile);
  container.append(element('h3', { text: 'Access identities' }));
  for (const identity of data.identities) {
    container.append(element('div', { className: 'admin-row' }, [
      element('div', {}, [
        element('strong', { text: identity.email }),
        element('small', { text: `${identity.issuer} · ${identity.subject}` }),
      ]),
      button('削除', () => removeIdentity(user.id, identity), 'danger'),
    ]));
  }
  const add = element('form', { className: 'inline-form' }, [
    input('issuer', 'url', '', 'https://team.cloudflareaccess.com'),
    input('subject', 'text', '', 'subject'),
    input('email', 'email', user.email),
    submit('identityを追加'),
  ]);
  add.addEventListener('submit', (event) => addIdentity(event, user.id));
  container.append(add);
}

async function updateProfile(event, userId) {
  event.preventDefault();
  const values = formValues(event.currentTarget);
  await perform(async () => {
    await adminApi.patchUser(userId, {
      email: values.email,
      ...(values.displayName ? { displayName: values.displayName } : { displayName: null }),
    });
    callbacks.status('ユーザー情報を更新しました。');
    await callbacks.changed();
  }, 'ユーザー情報を更新できませんでした。');
}

async function addIdentity(event, userId) {
  event.preventDefault();
  const values = formValues(event.currentTarget);
  await perform(async () => {
    await adminApi.addIdentity(userId, values);
    callbacks.status('Access identityを追加しました。');
    await callbacks.changed();
  }, 'Access identityを追加できませんでした。');
}

async function removeIdentity(userId, identity) {
  if (!confirm(`${identity.email} のidentityを削除しますか？`)) return;
  await perform(async () => {
    await adminApi.removeIdentity(userId, {
      issuer: identity.issuer, subject: identity.subject, email: identity.email,
    });
    callbacks.status('Access identityを削除しました。');
    await callbacks.changed();
  }, 'Access identityを削除できませんでした。');
}

function input(name, type, value, placeholder = '', required = true) {
  return element('input', { attributes: { name, type, value, placeholder, required } });
}

function submit(text) {
  return element('button', { text, attributes: { type: 'submit' } });
}

async function perform(operation, fallback) {
  try {
    await operation();
  } catch (error) {
    callbacks.error(error, fallback);
  }
}
