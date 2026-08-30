import { retryMessage } from './api.js';
import { state } from './state.js';
import { showStatus } from './shell.js';

export async function retryFailedMessage(messageId, loadMessages, openMessage, handleError) {
  try {
    await retryMessage(messageId);
  } catch (error) {
    if (error?.code === 'outbound_not_failed') {
      showStatus('このメールはすでに再送処理済みです。');
      await refreshMessage(messageId, loadMessages, openMessage);
      return;
    }
    handleError(error, 'メールを再送キューに追加できませんでした。');
    return;
  }
  showStatus('送信失敗メールを再送キューに追加しました。');
  await refreshMessage(messageId, loadMessages, openMessage);
}

async function refreshMessage(messageId, loadMessages, openMessage) {
  await loadMessages(false);
  if (state.selectedMessageId === messageId) await openMessage(messageId);
}
