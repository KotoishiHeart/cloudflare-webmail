const DATE_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const FULL_DATE_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  dateStyle: 'long',
  timeStyle: 'short',
});

export function shortDate(timestamp) {
  return DATE_FORMAT.format(new Date(timestamp));
}

export function fullDate(timestamp) {
  return FULL_DATE_FORMAT.format(new Date(timestamp));
}

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function senderLabel(value) {
  const match = String(value || '').match(/^([^<]+)</u);
  return (match?.[1] || value || '差出人不明').trim();
}

export const FOLDER_LABELS = {
  inbox: '受信箱',
  starred: 'スター付き',
  archive: 'アーカイブ',
  trash: 'ゴミ箱',
  all: 'すべてのメール',
};
