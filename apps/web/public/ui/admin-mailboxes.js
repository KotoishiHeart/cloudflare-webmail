import { adminApi } from './admin-api.js';
import { button, clear, element, formValues, statusPill } from './admin-dom.js';

let callbacks;
let users = [];
let selectedMailboxId = '';

export function bindAdminMailboxes(options) {
  callbacks = options;
  document.querySelector('#admin-mailbox-create').addEventListener('submit', createMailbox);
}

export function renderAdminMailboxes(mailboxes, nextUsers) {
  users = nextUsers;
  renderOwnerOptions();
  const list = clear(document.querySelector('#admin-mailbox-list'));
  if (mailboxes.length === 0) {
    list.append(element('p', { className: 'muted', text: 'メールボックスはありません。' }));
    return;
  }
  for (const mailbox of mailboxes) {
    const title = element('strong', { text: mailbox.displayName });
    title.append(statusPill(mailbox.status));
    const row = element('article', { className: 'admin-row' }, [
      element('div', {}, [
        title,
        element('small', {
          text: `${mailbox.primaryAddress || '主アドレスなし'} · ${mailbox.messageCount} messages · ${mailbox.memberCount} members`,
        }),
      ]),
      button('構成を編集', () => showMailboxDetail(mailbox.id)),
    ]);
    if (mailbox.id === selectedMailboxId) row.setAttribute('aria-current', 'true');
    list.append(row);
  }
}

async function createMailbox(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formValues(form);
  await perform(async () => {
    const data = await adminApi.createMailbox({
      address: values.address,
      ...(values.displayName ? { displayName: values.displayName } : {}),
      ownerUserId: values.ownerUserId,
    });
    selectedMailboxId = data.mailbox.mailbox.id;
    form.reset();
    callbacks.status('メールボックスを作成しました。');
    await refreshAndReopen();
  }, 'メールボックスを作成できませんでした。');
}

async function showMailboxDetail(mailboxId) {
  selectedMailboxId = mailboxId;
  await perform(async () => {
    const data = await adminApi.mailbox(mailboxId);
    renderMailboxDetail(data);
  }, 'メールボックス詳細を取得できませんでした。');
}

function renderMailboxDetail(data) {
  const container = clear(document.querySelector('#admin-mailbox-detail'));
  const mailbox = data.mailbox;
  const title = element('h2', { text: mailbox.displayName });
  title.append(statusPill(mailbox.status));
  container.append(title, element('p', { className: 'muted', text: mailbox.id }));
  container.append(button(
    mailbox.status === 'active' ? 'メールボックスを無効化' : 'メールボックスを有効化',
    () => toggleMailbox(mailbox),
    mailbox.status === 'active' ? 'danger' : '',
  ));

  container.append(element('h3', { text: '受信アドレス' }));
  for (const address of data.addresses) container.append(addressRow(mailbox.id, address));
  const addressForm = element('form', { className: 'inline-form' }, [
    input('address', 'email', 'alias@example.com'),
    select('kind', [['alias', 'alias'], ['primary', 'primary']]),
    submit('アドレスを追加'),
  ]);
  addressForm.addEventListener('submit', (event) => addAddress(event, mailbox.id));
  container.append(addressForm);

  container.append(element('h3', { text: 'メンバー' }));
  for (const member of data.members) container.append(memberRow(mailbox.id, member));
  const memberForm = element('form', { className: 'inline-form' }, [
    userSelect('userId'),
    select('role', [['viewer', 'viewer'], ['operator', 'operator'], ['owner', 'owner']]),
    submit('メンバーを設定'),
  ]);
  memberForm.addEventListener('submit', (event) => setMember(event, mailbox.id));
  container.append(memberForm);
}

function addressRow(mailboxId, address) {
  const title = element('strong', { text: address.address });
  title.append(statusPill(address.kind), statusPill(address.status));
  const actions = [];
  if (address.kind !== 'primary') {
    actions.push(
      button(
        address.status === 'active' ? '無効化' : '有効化',
        () => patchAddress(mailboxId, address),
      ),
      button('削除', () => removeAddress(mailboxId, address), 'danger'),
    );
  }
  return element('div', { className: 'admin-row' }, [title, element('div', {
    className: 'admin-row-actions',
  }, actions)]);
}

function memberRow(mailboxId, member) {
  const title = element('strong', { text: member.displayName || member.email });
  title.append(statusPill(member.role), statusPill(member.status));
  return element('div', { className: 'admin-row' }, [
    element('div', {}, [title, element('small', { text: member.email })]),
    button('メンバーから削除', () => removeMember(mailboxId, member), 'danger'),
  ]);
}

async function toggleMailbox(mailbox) {
  const status = mailbox.status === 'active' ? 'disabled' : 'active';
  if (status === 'disabled' && !confirm(`${mailbox.displayName} を無効化しますか？`)) return;
  await mutate(
    () => adminApi.patchMailbox(mailbox.id, { status }),
    'メールボックス状態を更新しました。',
    'メールボックス状態を更新できませんでした。',
  );
}

async function addAddress(event, mailboxId) {
  event.preventDefault();
  await mutate(
    () => adminApi.addAddress(mailboxId, formValues(event.currentTarget)),
    'アドレスを追加しました。',
    'アドレスを追加できませんでした。',
  );
}

async function patchAddress(mailboxId, address) {
  await mutate(
    () => adminApi.patchAddress(mailboxId, {
      address: address.address, status: address.status === 'active' ? 'disabled' : 'active',
    }),
    'アドレス状態を更新しました。',
    'アドレス状態を更新できませんでした。',
  );
}

async function removeAddress(mailboxId, address) {
  if (!confirm(`${address.address} を削除しますか？`)) return;
  await mutate(
    () => adminApi.removeAddress(mailboxId, { address: address.address }),
    'アドレスを削除しました。',
    'アドレスを削除できませんでした。',
  );
}

async function setMember(event, mailboxId) {
  event.preventDefault();
  const values = formValues(event.currentTarget);
  await mutate(
    () => adminApi.setMember(mailboxId, values.userId, values.role),
    'メンバーを更新しました。',
    'メンバーを更新できませんでした。',
  );
}

async function removeMember(mailboxId, member) {
  if (!confirm(`${member.email} をメンバーから削除しますか？`)) return;
  await mutate(
    () => adminApi.removeMember(mailboxId, member.userId),
    'メンバーを削除しました。',
    'メンバーを削除できませんでした。',
  );
}

async function mutate(operation, message, fallback) {
  await perform(async () => {
    await operation();
    callbacks.status(message);
    await refreshAndReopen();
  }, fallback);
}

async function refreshAndReopen() {
  await callbacks.changed();
  if (selectedMailboxId) await showMailboxDetail(selectedMailboxId);
}

function renderOwnerOptions() {
  const owner = clear(document.querySelector('#mailbox-owner'));
  for (const user of users.filter((entry) => entry.status === 'active')) {
    owner.append(element('option', { text: user.email, attributes: { value: user.id } }));
  }
}

function userSelect(name) {
  const node = element('select', { attributes: { name, required: true } });
  for (const user of users.filter((entry) => entry.status === 'active')) {
    node.append(element('option', { text: user.email, attributes: { value: user.id } }));
  }
  return node;
}

function input(name, type, placeholder) {
  return element('input', { attributes: { name, type, placeholder, required: true } });
}

function select(name, options) {
  return element('select', { attributes: { name } }, options.map(([value, label]) => (
    element('option', { text: label, attributes: { value } })
  )));
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
