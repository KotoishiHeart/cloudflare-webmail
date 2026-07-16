const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export function validateProvisionManifest(input) {
  if (!record(input) || input.version !== 1) fail('version must be 1');
  const users = array(input.users, 'users', 100).map((user, index) => validateUser(user, index));
  const userIds = unique(users.map((user) => user.id), 'user ID');
  unique(users.map((user) => user.email), 'user email');
  const identityKeys = users.flatMap((user) =>
    user.identities.map((identity) => `${identity.issuer}\u0000${identity.subject}`),
  );
  unique(identityKeys, 'Access identity');

  const mailboxes = array(input.mailboxes, 'mailboxes', 100)
    .map((mailbox, index) => validateMailbox(mailbox, index, userIds));
  unique(mailboxes.map((mailbox) => mailbox.id), 'mailbox ID');
  unique(mailboxes.flatMap((mailbox) => [mailbox.address, ...mailbox.aliases]), 'mailbox address');
  validateDefaultMailboxes(users, mailboxes);
  return { version: 1, users, mailboxes };
}

function validateUser(input, index) {
  const path = `users[${index}]`;
  if (!record(input)) fail(`${path} must be an object`);
  const email = emailAddress(input.email, `${path}.email`);
  return {
    id: uuid(input.id, `${path}.id`),
    email,
    displayName: optionalText(input.displayName, `${path}.displayName`, 160),
    systemAdmin: optionalBoolean(input.systemAdmin, `${path}.systemAdmin`, false),
    defaultMailboxId: input.defaultMailboxId === undefined
      ? undefined
      : input.defaultMailboxId === null
        ? null
        : uuid(input.defaultMailboxId, `${path}.defaultMailboxId`),
    identities: array(input.identities, `${path}.identities`, 20, 1)
      .map((identity, identityIndex) => validateIdentity(
        identity,
        `${path}.identities[${identityIndex}]`,
        email,
      )),
  };
}

function validateDefaultMailboxes(users, mailboxes) {
  const byId = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));
  for (const user of users) {
    if (user.defaultMailboxId === undefined || user.defaultMailboxId === null) continue;
    const mailbox = byId.get(user.defaultMailboxId);
    if (mailbox === undefined) fail('user defaultMailboxId does not reference a manifest mailbox');
    const authorized = mailbox.ownerUserId === user.id
      || mailbox.members.some((member) => member.userId === user.id);
    if (!authorized) fail('user defaultMailboxId requires a manifest mailbox membership');
  }
}

function validateIdentity(input, path, fallbackEmail) {
  if (!record(input)) fail(`${path} must be an object`);
  let issuer;
  try {
    issuer = new URL(text(input.issuer, `${path}.issuer`, 2048));
  } catch {
    fail(`${path}.issuer must be an absolute HTTPS URL`);
  }
  if (
    issuer.protocol !== 'https:'
    || issuer.username !== ''
    || issuer.password !== ''
    || issuer.search !== ''
    || issuer.hash !== ''
  ) {
    fail(`${path}.issuer must be an HTTPS URL without credentials, query, or fragment`);
  }
  const normalizedIssuer = issuer.href.endsWith('/') ? issuer.href.slice(0, -1) : issuer.href;
  return {
    issuer: normalizedIssuer,
    subject: text(input.subject, `${path}.subject`, 512),
    email: input.email === undefined
      ? fallbackEmail
      : emailAddress(input.email, `${path}.email`),
  };
}

function validateMailbox(input, index, userIds) {
  const path = `mailboxes[${index}]`;
  if (!record(input)) fail(`${path} must be an object`);
  const ownerUserId = uuid(input.ownerUserId, `${path}.ownerUserId`);
  if (!userIds.has(ownerUserId)) fail(`${path}.ownerUserId does not reference a manifest user`);
  const aliases = array(input.aliases ?? [], `${path}.aliases`, 100)
    .map((alias, aliasIndex) => emailAddress(alias, `${path}.aliases[${aliasIndex}]`));
  const members = array(input.members ?? [], `${path}.members`, 100)
    .map((member, memberIndex) => validateMember(
      member,
      `${path}.members[${memberIndex}]`,
      userIds,
    ));
  if (members.some((member) => member.userId === ownerUserId)) {
    fail(`${path}.members must not repeat ownerUserId`);
  }
  unique(members.map((member) => member.userId), `${path} member`);
  return {
    id: uuid(input.id, `${path}.id`),
    address: emailAddress(input.address, `${path}.address`),
    displayName: optionalText(input.displayName, `${path}.displayName`, 160)
      ?? emailAddress(input.address, `${path}.address`),
    ownerUserId,
    aliases,
    members,
  };
}

function validateMember(input, path, userIds) {
  if (!record(input)) fail(`${path} must be an object`);
  const userId = uuid(input.userId, `${path}.userId`);
  if (!userIds.has(userId)) fail(`${path}.userId does not reference a manifest user`);
  if (input.role !== 'viewer' && input.role !== 'operator' && input.role !== 'owner') {
    fail(`${path}.role must be viewer, operator, or owner`);
  }
  return { userId, role: input.role };
}

function uuid(value, path) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!UUID.test(normalized)) fail(`${path} must be a UUID`);
  return normalized;
}

function emailAddress(value, path) {
  const normalized = String(value ?? '').trim().toLowerCase();
  const at = normalized.indexOf('@');
  if (
    normalized.length < 3
    || normalized.length > 320
    || at < 1
    || at !== normalized.lastIndexOf('@')
    || at === normalized.length - 1
    || /\s/u.test(normalized)
    || CONTROL.test(normalized)
  ) fail(`${path} must be a valid mailbox address`);
  if (normalized.slice(0, at).length > 64 || normalized.slice(at + 1).length > 255) {
    fail(`${path} exceeds mailbox address limits`);
  }
  return normalized;
}

function optionalText(value, path, max) {
  if (value === undefined || value === null) return undefined;
  return text(value, path, max);
}

function optionalBoolean(value, path, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${path} must be boolean`);
  return value;
}

function text(value, path, max) {
  if (typeof value !== 'string') fail(`${path} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > max || CONTROL.test(normalized)) {
    fail(`${path} must contain between 1 and ${max} visible characters`);
  }
  return normalized;
}

function array(value, path, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(`${path} must contain between ${min} and ${max} items`);
  }
  return value;
}

function unique(values, label) {
  const set = new Set();
  for (const value of values) {
    const key = String(value).toLowerCase();
    if (set.has(key)) fail(`duplicate ${label}: ${value}`);
    set.add(key);
  }
  return set;
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}
