import { DatabaseInputError } from './validation.js';

const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export type MailRuleConditions = {
  fromContains: string;
  toContains: string;
  subjectContains: string;
  participantDomain: string;
  keyword: string;
  attachment: 'any' | 'with' | 'without';
  minimumBytes: number | null;
  maximumBytes: number | null;
  direction: 'any' | 'inbound' | 'outbound';
};

export type MailRuleActions = {
  star: boolean;
  archive: boolean;
  trash: boolean;
  labelIds: string[];
};

export type MailRuleDefinition = {
  name: string;
  enabled: boolean;
  priority: number;
  conditions: MailRuleConditions;
  actions: MailRuleActions;
  applyExisting: boolean;
  applyIncoming: boolean;
  stopProcessing: boolean;
};

export type MailRule = MailRuleDefinition & {
  id: string;
  mailboxId: string;
  revision: number;
  lastPreviewCount: number;
  lastPreviewAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export function normalizeMailRuleDefinition(input: MailRuleDefinition): MailRuleDefinition {
  const conditions = normalizeConditions(input.conditions);
  const actions = normalizeActions(input.actions);
  if (!Number.isSafeInteger(input.priority) || input.priority < 1 || input.priority > 9999) {
    throw new DatabaseInputError('priority', 'must be an integer between 1 and 9999');
  }
  for (const [field, value] of Object.entries({
    enabled: input.enabled,
    applyExisting: input.applyExisting,
    applyIncoming: input.applyIncoming,
    stopProcessing: input.stopProcessing,
  })) {
    if (typeof value !== 'boolean') throw new DatabaseInputError(field, 'must be boolean');
  }
  return {
    name: boundedText(input.name, 'name', 120, true),
    enabled: input.enabled,
    priority: input.priority,
    conditions,
    actions,
    applyExisting: input.applyExisting,
    applyIncoming: input.applyIncoming,
    stopProcessing: input.stopProcessing,
  };
}

export function parseMailRuleConditions(raw: string): MailRuleConditions {
  try {
    return normalizeConditions(JSON.parse(raw) as MailRuleConditions);
  } catch (error) {
    if (error instanceof DatabaseInputError) throw error;
    throw new DatabaseInputError('conditions', 'stored JSON is invalid');
  }
}

export function parseMailRuleActions(raw: string): MailRuleActions {
  try {
    return normalizeActions(JSON.parse(raw) as MailRuleActions);
  } catch (error) {
    if (error instanceof DatabaseInputError) throw error;
    throw new DatabaseInputError('actions', 'stored JSON is invalid');
  }
}

function normalizeConditions(input: MailRuleConditions): MailRuleConditions {
  if (typeof input !== 'object' || input === null) {
    throw new DatabaseInputError('conditions', 'must be an object');
  }
  if (!['any', 'with', 'without'].includes(input.attachment)) {
    throw new DatabaseInputError('conditions.attachment', 'is unsupported');
  }
  if (!['any', 'inbound', 'outbound'].includes(input.direction)) {
    throw new DatabaseInputError('conditions.direction', 'is unsupported');
  }
  const minimumBytes = optionalBytes(input.minimumBytes, 'conditions.minimumBytes');
  const maximumBytes = optionalBytes(input.maximumBytes, 'conditions.maximumBytes');
  if (minimumBytes !== null && maximumBytes !== null && minimumBytes > maximumBytes) {
    throw new DatabaseInputError('conditions.maximumBytes', 'must be at least minimumBytes');
  }
  return {
    fromContains: boundedText(input.fromContains, 'conditions.fromContains', 320),
    toContains: boundedText(input.toContains, 'conditions.toContains', 320),
    subjectContains: boundedText(input.subjectContains, 'conditions.subjectContains', 998),
    participantDomain: normalizeDomain(input.participantDomain),
    keyword: boundedText(input.keyword, 'conditions.keyword', 200),
    attachment: input.attachment,
    minimumBytes,
    maximumBytes,
    direction: input.direction,
  };
}

function normalizeActions(input: MailRuleActions): MailRuleActions {
  if (typeof input !== 'object' || input === null || !Array.isArray(input.labelIds)) {
    throw new DatabaseInputError('actions', 'must be an object with labelIds');
  }
  for (const field of ['star', 'archive', 'trash'] as const) {
    if (typeof input[field] !== 'boolean') {
      throw new DatabaseInputError(`actions.${field}`, 'must be boolean');
    }
  }
  if (input.archive && input.trash) {
    throw new DatabaseInputError('actions', 'archive and trash cannot both be enabled');
  }
  const labelIds = [...new Set(input.labelIds.map((id) => {
    if (typeof id !== 'string') throw new DatabaseInputError('actions.labelIds', 'must contain strings');
    return id.trim().toLowerCase();
  }))];
  if (labelIds.length > 10) throw new DatabaseInputError('actions.labelIds', 'must contain at most 10 labels');
  if (!input.star && !input.archive && !input.trash && labelIds.length === 0) {
    throw new DatabaseInputError('actions', 'must contain at least one action');
  }
  return { star: input.star, archive: input.archive, trash: input.trash, labelIds };
}

function optionalBytes(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MESSAGE_BYTES) {
    throw new DatabaseInputError(field, `must be null or an integer up to ${MAX_MESSAGE_BYTES}`);
  }
  return value;
}

function normalizeDomain(value: string): string {
  const domain = boundedText(value, 'conditions.participantDomain', 253).toLowerCase();
  if (domain === '') return '';
  if (domain.startsWith('.') || domain.endsWith('.') || !/^[a-z0-9.-]+$/u.test(domain)) {
    throw new DatabaseInputError('conditions.participantDomain', 'must be a DNS domain');
  }
  return domain;
}

function boundedText(value: string, field: string, max: number, required = false): string {
  if (typeof value !== 'string') throw new DatabaseInputError(field, 'must be a string');
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if ((required && normalized === '') || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new DatabaseInputError(field, required
      ? `must be between 1 and ${max} visible characters`
      : `must contain at most ${max} visible characters`);
  }
  return normalized;
}
