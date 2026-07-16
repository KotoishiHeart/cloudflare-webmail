import { adminApi } from './admin-api.js';
import { clear, dateTime, element, field, formValues } from './admin-dom.js';

let callbacks;

export function bindAdminEvents(options) {
  callbacks = options;
  document.querySelector('#audit-tab').addEventListener('click', () => selectTab('audit'));
  document.querySelector('#delivery-tab').addEventListener('click', () => selectTab('delivery'));
  document.querySelector('.admin-tabs').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      selectTab(document.querySelector('#audit-panel').hidden ? 'audit' : 'delivery');
    }
  });
  document.querySelector('#audit-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    loadAudit(formValues(event.currentTarget));
  });
  document.querySelector('#delivery-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    loadDelivery(formValues(event.currentTarget));
  });
}

export async function loadAdminEvents() {
  await Promise.all([loadAudit({}), loadDelivery({})]);
}

async function loadAudit(filters) {
  await perform(async () => {
    const data = await adminApi.auditEvents(filters);
    renderAudit(data.events.items);
  }, '監査イベントを取得できませんでした。');
}

async function loadDelivery(filters) {
  await perform(async () => {
    const data = await adminApi.deliveryEvents(filters);
    renderDelivery(data.events.items);
  }, '配送イベントを取得できませんでした。');
}

function renderAudit(events) {
  const list = clear(document.querySelector('#audit-list'));
  if (events.length === 0) return list.append(empty());
  for (const event of events) {
    const severity = String(field(event, 'severity'));
    list.append(eventRow(
      `${field(event, 'category')} · ${field(event, 'action')}`,
      `${field(event, 'actor_email', 'actor_email') || 'unknown'} · ${dateTime(field(event, 'createdAt', 'created_at'))}`,
      `target=${field(event, 'targetId', 'target_id') || '—'} · status=${detailsStatus(event)}`,
      severity,
    ));
  }
}

function renderDelivery(events) {
  const list = clear(document.querySelector('#delivery-list'));
  if (events.length === 0) return list.append(empty());
  for (const event of events) {
    const status = String(field(event, 'status'));
    list.append(eventRow(
      `${field(event, 'direction')} · ${field(event, 'stage')} · ${field(event, 'category')}`,
      `${status} · ${dateTime(field(event, 'createdAt', 'created_at'))}`,
      `${field(event, 'summary') || '概要なし'} · message=${field(event, 'messageId', 'message_id') || '—'}`,
      status,
    ));
  }
}

function eventRow(title, metadata, detail, state) {
  return element('article', { className: `event-row ${state}` }, [
    element('strong', { text: title }),
    element('small', { text: metadata }),
    element('small', { text: detail }),
  ]);
}

function detailsStatus(event) {
  try {
    const details = JSON.parse(String(field(event, 'detailsJson', 'details_json') || '{}'));
    return details.status ?? '—';
  } catch {
    return '—';
  }
}

function empty() {
  return element('p', { className: 'muted', text: '該当するイベントはありません。' });
}

function selectTab(name) {
  const audit = name === 'audit';
  document.querySelector('#audit-tab').setAttribute('aria-selected', String(audit));
  document.querySelector('#delivery-tab').setAttribute('aria-selected', String(!audit));
  document.querySelector('#audit-tab').tabIndex = audit ? 0 : -1;
  document.querySelector('#delivery-tab').tabIndex = audit ? -1 : 0;
  document.querySelector('#audit-panel').hidden = !audit;
  document.querySelector('#delivery-panel').hidden = audit;
  document.querySelector(audit ? '#audit-filter select' : '#delivery-filter select').focus();
}

async function perform(operation, fallback) {
  try {
    await operation();
  } catch (error) {
    callbacks.error(error, fallback);
  }
}
