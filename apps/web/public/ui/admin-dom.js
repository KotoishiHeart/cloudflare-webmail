export function clear(node) {
  node.replaceChildren();
  return node;
}

export function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  for (const [name, value] of Object.entries(options.attributes || {})) {
    if (value === false || value === null || value === undefined) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  node.append(...children.filter(Boolean));
  return node;
}

export function button(text, action, className = '') {
  const node = element('button', { text, className, attributes: { type: 'button' } });
  node.addEventListener('click', action);
  return node;
}

export function statusPill(status) {
  return element('span', { text: status, className: `status-pill ${status}` });
}

export function dateTime(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(number)
    : '—';
}

export function field(row, camel, snake = camel) {
  return row?.[camel] ?? row?.[snake];
}

export function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}
