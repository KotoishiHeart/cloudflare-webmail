export function createMessageActionsController(dependencies) {
  async function apply(messageId, patch, previous) {
    try {
      await dependencies.patchMessage(messageId, patch);
      await refresh(messageId);
      const inverse = Object.fromEntries(
        Object.keys(patch).map((key) => [key, Boolean(previous[key])]),
      );
      dependencies.status('メッセージを更新しました。', false, {
        label: '元に戻す',
        activate: () => undo(messageId, inverse),
      });
    } catch (error) {
      dependencies.error(error, 'メッセージを更新できませんでした。');
    }
  }

  async function undo(messageId, patch) {
    try {
      await dependencies.patchMessage(messageId, patch);
      await refresh(messageId);
      dependencies.status('メッセージを元の状態へ戻しました。');
    } catch (error) {
      dependencies.error(error, 'メッセージを元に戻せませんでした。');
    }
  }

  async function refresh(messageId) {
    await dependencies.loadMessages(false);
    if (dependencies.state.messages.some((message) => message.id === messageId)) {
      await dependencies.openMessage(messageId);
    } else {
      dependencies.closeDetail();
    }
  }

  return { apply };
}
