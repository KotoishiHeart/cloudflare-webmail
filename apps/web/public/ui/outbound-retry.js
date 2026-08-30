import { retryMessage } from './api.js';
import { state } from './state.js';
import { showStatus } from './shell.js';

export async function retryFailedMessage(messageId, loadMessages, openMessage, handleError) {
  try {
    await retryMessage(messageId);
    showStatus('送信失敗メールを再送キューに追加しました。');
    await loadMessages(false);
    if (state.selectedMessageId === messageId) await openMessage(messageId);
  } catch (error) {
    handleError(error, 'メールを再送キューに追加できませんでした。');
  }
}
