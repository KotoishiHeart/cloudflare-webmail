const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export function normalizeLegacyLabel(row, sourceId, now) {
  const createdAt = positiveOr(row.created_at, now);
  const rawColor = String(row.color ?? '').toLowerCase();
  return {
    name: safeVisible(row.name, 80, `Legacy label ${sourceId}`),
    color: /^#[0-9a-f]{6}$/u.test(rawColor) ? rawColor : '#64748b',
    description: safeVisible(row.description, 240, ''),
    createdAt,
    updatedAt: positiveOr(row.updated_at, createdAt),
  };
}

export function normalizeLegacyRule(row, index, names, now) {
  const sourceId = identifier(row.id, 128);
  const match = jsonObject(row.match_json, `mail rule ${sourceId} match_json`);
  const action = jsonObject(row.action_json, `mail rule ${sourceId} action_json`);
  const actionLabel = safeVisible(action.label, 80, '');
  const actions = {
    star: Boolean(action.star),
    archive: Boolean(action.archive) && !Boolean(action.trash),
    trash: Boolean(action.trash),
    labelIds: [],
  };
  if (!actions.star && !actions.archive && !actions.trash && actionLabel === '') {
    throw new Error(`legacy mail rule has no supported action: ${sourceId}`);
  }
  const createdAt = positiveOr(row.created_at, now);
  return {
    sourceId,
    name: uniqueName(
      safeVisible(row.name, 120, `Legacy rule ${index + 1}`), sourceId, names,
    ),
    enabled: Number(row.enabled) !== 0,
    priority: integer(row.priority, 1, 9999, 100),
    conditions: conditions(match),
    actions,
    actionLabel,
    actionLabelKey: '',
    applyExisting: Number(row.apply_existing) !== 0,
    applyIncoming: Number(row.apply_incoming) !== 0,
    lastPreviewCount: integer(row.last_preview_count, 0, Number.MAX_SAFE_INTEGER, 0),
    lastPreviewAt: optionalPositive(row.last_preview_at),
    lastRunAt: optionalPositive(row.last_run_at),
    createdAt,
    updatedAt: positiveOr(row.updated_at, createdAt),
  };
}

export function normalizeLegacyPreference(row, mailboxByAddress, now) {
  const email = String(row.key).slice('user_pref:'.length).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/u.test(email) || email.length > 320) {
    throw new Error('legacy user preference key has an invalid email');
  }
  const value = jsonObject(row.value, `user preference ${email}`);
  const requestedSize = Number(value.page_size);
  const pageSize = [25, 50, 100, 200].includes(requestedSize)
    ? Math.min(requestedSize, 50) : 50;
  const account = String(value.default_account ?? '').trim().toLowerCase();
  return {
    email,
    pageSize,
    compactLayout: Boolean(value.dense_list),
    defaultMailboxId: mailboxByAddress.get(account) ?? null,
    updatedAt: positiveOr(row.updated_at, now),
  };
}

export function safeVisible(value, maximum, fallback) {
  const normalized = String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ').slice(0, maximum);
  return normalized || fallback;
}

function conditions(match) {
  const minimumBytes = kilobytes(match.min_size_kb, 'minimum');
  const maximumBytes = kilobytes(match.max_size_kb, 'maximum');
  if (minimumBytes !== null && maximumBytes !== null && minimumBytes > maximumBytes) {
    throw new Error('legacy mail rule maximum size is below its minimum');
  }
  return {
    fromContains: safeVisible(match.from, 320, ''),
    toContains: safeVisible(match.to, 320, ''),
    subjectContains: safeVisible(match.subject, 998, ''),
    participantDomain: domain(match.domain),
    keyword: safeVisible(match.keyword, 200, ''),
    attachment: match.has_attachments === 'yes'
      ? 'with' : match.has_attachments === 'no' ? 'without' : 'any',
    minimumBytes,
    maximumBytes,
    direction: match.direction === 'in'
      ? 'inbound' : match.direction === 'sent' ? 'outbound' : 'any',
  };
}

function domain(value) {
  const normalized = safeVisible(value, 253, '').toLowerCase();
  if (normalized !== '' && (normalized.startsWith('.') || normalized.endsWith('.')
    || !/^[a-z0-9.-]+$/u.test(normalized))) throw new Error('legacy rule domain is invalid');
  return normalized;
}

function kilobytes(value, name) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) throw new Error(`legacy rule ${name} size is invalid`);
  if (number === 0) return null;
  const bytes = Math.floor(number * 1024);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_MESSAGE_BYTES) {
    throw new Error(`legacy rule ${name} size exceeds the current message limit`);
  }
  return bytes;
}

function uniqueName(base, sourceId, seen) {
  let name = base;
  if (seen.has(name.toLowerCase())) name = `${base.slice(0, 101)} [legacy ${sourceId.slice(0, 8)}]`;
  let suffix = 2;
  while (seen.has(name.toLowerCase())) name = `${base.slice(0, 108)} [${suffix++}]`;
  seen.add(name.toLowerCase());
  return name;
}

function jsonObject(value, name) {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`legacy ${name} is not a JSON object`);
  }
}

function identifier(value, maximum) {
  const normalized = String(value ?? '');
  if (normalized === '' || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error('legacy configuration identifier is invalid');
  }
  return normalized;
}

function positiveOr(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function optionalPositive(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function integer(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}
