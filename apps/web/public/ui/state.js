import { EMPTY_SEARCH_FILTERS } from './search.js';

export const state = {
  session: null,
  mailboxId: '',
  folder: 'inbox',
  messages: [],
  nextCursor: null,
  selectedMessageId: '',
  busy: false,
  activeLoads: 0,
  revision: 0,
  searchFilters: { ...EMPTY_SEARCH_FILTERS },
};

export function setSearchFilters(filters) {
  state.searchFilters = { ...EMPTY_SEARCH_FILTERS, ...filters };
  state.selectedMessageId = '';
  state.messages = [];
  state.nextCursor = null;
  state.revision += 1;
}

export function replaceMessagePage(page) {
  state.messages = page.messages;
  state.nextCursor = page.nextCursor;
}

export function appendMessagePage(page) {
  const known = new Set(state.messages.map((message) => message.id));
  state.messages.push(...page.messages.filter((message) => !known.has(message.id)));
  state.nextCursor = page.nextCursor;
}

export function selectMailbox(mailboxId) {
  state.mailboxId = mailboxId;
  state.selectedMessageId = '';
  state.messages = [];
  state.nextCursor = null;
  state.revision += 1;
}

export function selectFolder(folder) {
  state.folder = folder;
  state.selectedMessageId = '';
  state.messages = [];
  state.nextCursor = null;
  state.revision += 1;
}
