const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AUDIENCE = /^[0-9a-f]{64}$/u;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export function validateDeploymentManifest(input) {
  object(input, 'manifest');
  keys(input, [
    'version', 'environment', 'mode', 'accountId', 'hostname', 'workers',
    'access', 'resources', 'email', 'limits',
  ], 'manifest');
  if (input.version !== 1) fail('version must be 1');
  const workers = validateWorkers(input.workers);
  const resources = validateResources(input.resources);
  const sendingDomains = domains(input.email, 'sendingDomains');
  const routingDomains = domains(input.email, 'routingDomains');
  const sendingVerification = validateSendingVerification(input.email.sendingVerification);
  return {
    version: 1,
    environment: name(input.environment, 'environment'),
    mode: enumValue(input.mode, ['initial', 'upgrade'], 'mode'),
    accountId: pattern(input.accountId, ACCOUNT_ID, 'accountId'),
    hostname: domain(input.hostname, 'hostname'),
    workers,
    access: validateAccess(input.access),
    resources,
    email: {
      sendingDomains,
      routingDomains,
      ...(sendingVerification === undefined ? {} : { sendingVerification }),
    },
    limits: validateLimits(input.limits),
  };
}

function validateWorkers(input) {
  object(input, 'workers');
  keys(input, ['web', 'ingest', 'jobs'], 'workers');
  const result = {
    web: name(input.web, 'workers.web'),
    ingest: name(input.ingest, 'workers.ingest'),
    jobs: name(input.jobs, 'workers.jobs'),
  };
  unique(Object.values(result), 'worker name');
  return result;
}

function validateAccess(input) {
  object(input, 'access');
  keys(input, ['teamDomain', 'audience'], 'access');
  let team;
  try {
    team = new URL(input.teamDomain);
  } catch {
    fail('access.teamDomain must be an HTTPS cloudflareaccess.com URL');
  }
  if (
    team.protocol !== 'https:'
    || !/^[a-z0-9-]+\.cloudflareaccess\.com$/u.test(team.hostname)
    || team.pathname !== '/'
    || team.search !== ''
    || team.hash !== ''
    || team.username !== ''
    || team.password !== ''
  ) fail('access.teamDomain must be an HTTPS cloudflareaccess.com origin');
  return {
    teamDomain: team.origin,
    audience: pattern(input.audience, AUDIENCE, 'access.audience'),
  };
}

function validateResources(input) {
  object(input, 'resources');
  keys(input, ['d1', 'r2', 'queues'], 'resources');
  object(input.d1, 'resources.d1');
  keys(input.d1, ['name', 'id'], 'resources.d1');
  object(input.r2, 'resources.r2');
  keys(input.r2, ['bucket'], 'resources.r2');
  object(input.queues, 'resources.queues');
  keys(input.queues, ['inbound', 'inboundDlq', 'outbound', 'outboundDlq'], 'resources.queues');
  const queues = {
    inbound: name(input.queues.inbound, 'resources.queues.inbound'),
    inboundDlq: name(input.queues.inboundDlq, 'resources.queues.inboundDlq'),
    outbound: name(input.queues.outbound, 'resources.queues.outbound'),
    outboundDlq: name(input.queues.outboundDlq, 'resources.queues.outboundDlq'),
  };
  unique(Object.values(queues), 'queue name');
  return {
    d1: {
      name: name(input.d1.name, 'resources.d1.name'),
      id: pattern(input.d1.id, UUID, 'resources.d1.id'),
    },
    r2: { bucket: name(input.r2.bucket, 'resources.r2.bucket') },
    queues,
  };
}

function domains(input, key) {
  object(input, 'email');
  keys(input, ['sendingDomains', 'routingDomains', 'sendingVerification'], 'email');
  const value = input[key];
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) {
    fail(`email.${key} must contain between 1 and 30 domains`);
  }
  const normalized = value.map((item, index) => domain(item, `email.${key}[${index}]`));
  unique(normalized, `email.${key}`);
  return normalized;
}

function validateSendingVerification(input) {
  if (input === undefined) return undefined;
  object(input, 'email.sendingVerification');
  keys(input, ['method', 'verifiedAt', 'evidenceReference', 'confirmation'], 'email.sendingVerification');
  if (input.method !== 'dashboard') fail('email.sendingVerification.method must be dashboard');
  const verifiedAt = String(input.verifiedAt ?? '').trim();
  const timestamp = Date.parse(verifiedAt);
  if (!Number.isFinite(timestamp)) fail('email.sendingVerification.verifiedAt must be an ISO timestamp');
  const evidenceReference = boundedText(
    input.evidenceReference,
    'email.sendingVerification.evidenceReference',
  );
  if (input.confirmation !== 'EMAIL_SENDING_READY') {
    fail('email.sendingVerification.confirmation must be EMAIL_SENDING_READY');
  }
  return { method: 'dashboard', verifiedAt, evidenceReference, confirmation: input.confirmation };
}

function validateLimits(input) {
  object(input, 'limits');
  keys(input, ['queueMaxConcurrency'], 'limits');
  if (!Number.isSafeInteger(input.queueMaxConcurrency) || input.queueMaxConcurrency < 1 || input.queueMaxConcurrency > 20) {
    fail('limits.queueMaxConcurrency must be an integer from 1 through 20');
  }
  return { queueMaxConcurrency: input.queueMaxConcurrency };
}

function domain(value, path) {
  if (typeof value !== 'string') fail(`${path} must be a domain name`);
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3
    || normalized.length > 253
    || !normalized.includes('.')
    || normalized.split('.').some((label) => !NAME.test(label))
  ) fail(`${path} must be an ASCII domain name`);
  return normalized;
}

function name(value, path) {
  return pattern(value, NAME, path);
}

function pattern(value, expression, path) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!expression.test(normalized)) fail(`${path} has an invalid format`);
  return normalized;
}

function boundedText(value, path) {
  if (typeof value !== 'string') fail(`${path} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 200 || /[\r\n]/u.test(normalized)) {
    fail(`${path} must contain between 1 and 200 characters on one line`);
  }
  return normalized;
}

function enumValue(value, allowed, path) {
  if (!allowed.includes(value)) fail(`${path} must be ${allowed.join(' or ')}`);
  return value;
}

function unique(values, label) {
  if (new Set(values).size !== values.length) fail(`duplicate ${label}`);
}

function object(value, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
}

function keys(value, allowed, path) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) fail(`${path} contains unknown field: ${unexpected[0]}`);
}

function fail(message) {
  throw new Error(message);
}
