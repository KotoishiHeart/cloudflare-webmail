const form = document.querySelector('#search-form');
const quickFilter = document.querySelector('#search-filter');
const details = document.querySelector('#search-details');
const activeCount = document.querySelector('#search-active-count');

export const EMPTY_SEARCH_FILTERS = Object.freeze({
  q: '',
  filter: 'all',
  from: '',
  to: '',
  domain: '',
  dateFrom: '',
  dateTo: '',
  attachment: 'any',
  read: 'any',
  starred: 'any',
  minKb: '',
  maxKb: '',
});

export function bindSearch({ onSearch, onClear }) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    onSearch(readFilters());
  });
  quickFilter.addEventListener('change', () => onSearch(readFilters()));
  document.querySelector('#search-clear').addEventListener('click', () => {
    renderSearch(EMPTY_SEARCH_FILTERS);
    onClear();
  });
  form.addEventListener('input', updateActiveCount);
  form.addEventListener('change', updateActiveCount);
}

export function renderSearch(filters) {
  for (const [name, value] of Object.entries(filters)) {
    const control = form.elements.namedItem(name);
    if (control) control.value = value;
  }
  updateActiveCount();
}

export function hasActiveSearch(filters) {
  return filters.q !== '' || filters.filter !== 'all' || advancedCount(filters) > 0;
}

function readFilters() {
  const data = new FormData(form);
  return Object.fromEntries(Object.keys(EMPTY_SEARCH_FILTERS).map((name) => [
    name,
    String(data.get(name) ?? '').trim(),
  ]));
}

function updateActiveCount() {
  const filters = readFilters();
  const count = advancedCount(filters);
  activeCount.textContent = count > 0 ? `${count}件` : '';
  if (count > 0) details.open = true;
}

function advancedCount(filters) {
  return [
    filters.from,
    filters.to,
    filters.domain,
    filters.dateFrom,
    filters.dateTo,
    filters.attachment === 'any' ? '' : filters.attachment,
    filters.read === 'any' ? '' : filters.read,
    filters.starred === 'any' ? '' : filters.starred,
    filters.minKb,
    filters.maxKb,
  ].filter(Boolean).length;
}
