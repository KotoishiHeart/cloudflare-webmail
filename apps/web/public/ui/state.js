import { EMPTY_SEARCH_FILTERS } from './search.js';

export const state = {
  session: null,
  mailboxId: '',
  folder: 'inbox',
  messages: [],
  nextCursor: null,
  selectedMessageId: '',
  selectedMessageIds: new Set(),
  busy: false,
  activeLoads: 0,
  revision: 0,
  searchFilters: { ...EMPTY_SEARCH_FILTERS },
  labels: [],
  rules: [],
  ruleRuns: [],
  preferences: {
    theme: 'system',
    pageSize: 30,
    defaultFolder: 'inbox',
    showHtmlByDefault: true,
    compactLayout: false,
  },
};

export function setSearchFilters(filters) {
  state.searchFilters = { ...EMPTY_SEARCH_FILTERS, ...filters };
  state.selectedMessageId = '';
  state.messages = [];
  state.nextCursor = null;
  state.selectedMessageIds.clear();
  state.revision += 1;
}

export function replaceMessagePage(page) {
  state.messages = page.messages;
  state.nextCursor = page.nextCursor;
  state.selectedMessageIds.clear();
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
  state.selectedMessageIds.clear();
  state.labels = [];
  state.rules = [];
  state.ruleRuns = [];
  state.revision += 1;
}

export function setLabels(labels) {
  state.labels = labels;
}

export function setPreferences(preferences) {
  state.preferences = { ...state.preferences, ...preferences };
}

export function setRules(rules, runs) {
  state.rules = rules;
  state.ruleRuns = runs;
}

export function selectFolder(folder) {
  state.folder = folder;
  state.selectedMessageId = '';
  state.messages = [];
  state.nextCursor = null;
  state.selectedMessageIds.clear();
  state.revision += 1;
}
