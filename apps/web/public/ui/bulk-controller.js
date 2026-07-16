const CHUNK_SIZE = 40;

export function createBulkController(dependencies) {
  const toolbar = document.querySelector('#bulk-toolbar');
  const selectAll = document.querySelector('#bulk-select-all');
  const count = document.querySelector('#bulk-count');
  const actions = [...toolbar.querySelectorAll('[data-bulk-field]')];
  let busy = false;

  selectAll.addEventListener('change', () => {
    for (const message of dependencies.state.messages) {
      if (selectAll.checked) dependencies.state.selectedMessageIds.add(message.id);
      else dependencies.state.selectedMessageIds.delete(message.id);
    }
    for (const checkbox of document.querySelectorAll('[data-message-select]')) {
      checkbox.checked = selectAll.checked;
      checkbox.closest('.message-row')?.classList.toggle('selected', selectAll.checked);
    }
    render();
  });
  for (const button of actions) {
    button.addEventListener('click', () => apply(button.dataset.bulkField, button.dataset.bulkValue));
  }

  function toggle(messageId, selected) {
    if (selected) dependencies.state.selectedMessageIds.add(messageId);
    else dependencies.state.selectedMessageIds.delete(messageId);
    render();
  }

  function render() {
    const mailbox = dependencies.getMailbox();
    const visibleIds = dependencies.state.messages.map((message) => message.id);
    const selected = visibleIds.filter((id) => dependencies.state.selectedMessageIds.has(id));
    toolbar.hidden = visibleIds.length === 0 || !mailbox || mailbox.role === 'viewer';
    selectAll.checked = visibleIds.length > 0 && selected.length === visibleIds.length;
    selectAll.indeterminate = selected.length > 0 && selected.length < visibleIds.length;
    count.textContent = `${selected.length}件選択`;
    for (const button of actions) button.disabled = busy || selected.length === 0;
    const trash = toolbar.querySelector('[data-bulk-field="isDeleted"]');
    trash.dataset.bulkValue = dependencies.state.folder === 'trash' ? 'false' : 'true';
    trash.textContent = dependencies.state.folder === 'trash' ? '復元' : 'ゴミ箱へ';
  }

  async function apply(field, rawValue) {
    if (busy || !isFlag(field)) return;
    const value = rawValue === 'true';
    const selected = dependencies.state.messages
      .filter((message) => dependencies.state.selectedMessageIds.has(message.id));
    if (selected.length === 0) return;
    const previous = selected.map((message) => ({ id: message.id, value: Boolean(message[field]) }));
    busy = true;
    render();
    try {
      await patchInChunks(dependencies, selected.map((message) => message.id), { [field]: value });
      dependencies.state.selectedMessageIds.clear();
      await dependencies.loadMessages(false);
      dependencies.status(`${selected.length}件のメールを更新しました。`, false, {
        label: '元に戻す',
        activate: () => undo(field, previous),
      });
    } catch (error) {
      dependencies.error(error, '一括操作を完了できませんでした。再読み込みして状態を確認してください。');
    } finally {
      busy = false;
      render();
    }
  }

  async function undo(field, previous) {
    const trueIds = previous.filter((item) => item.value).map((item) => item.id);
    const falseIds = previous.filter((item) => !item.value).map((item) => item.id);
    try {
      await patchInChunks(dependencies, trueIds, { [field]: true });
      await patchInChunks(dependencies, falseIds, { [field]: false });
      await dependencies.loadMessages(false);
      dependencies.status(`${previous.length}件を元の状態へ戻しました。`);
    } catch (error) {
      dependencies.error(error, '元に戻せませんでした。再読み込みして状態を確認してください。');
    }
  }

  return { render, toggle };
}

async function patchInChunks(dependencies, ids, patch) {
  for (let index = 0; index < ids.length; index += CHUNK_SIZE) {
    await dependencies.patchMessages(
      dependencies.state.mailboxId,
      ids.slice(index, index + CHUNK_SIZE),
      patch,
    );
  }
}

function isFlag(value) {
  return ['isRead', 'isStarred', 'isArchived', 'isDeleted'].includes(value);
}
