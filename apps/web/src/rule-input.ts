import type {
  MailRuleActions,
  MailRuleConditions,
  MailRuleDefinition,
} from '@cf-webmail/database';
import {
  ApiInputError,
  isRecord,
  readBoundedJson,
  UnsupportedMediaTypeError,
} from './api-input.js';

const MAX_RULE_INPUT_BYTES = 16 * 1024;

export type MailRulePatch = Partial<Omit<MailRuleDefinition, 'conditions' | 'actions'>> & {
  conditions?: Partial<MailRuleConditions>;
  actions?: Partial<MailRuleActions>;
};

export async function readMailRulePatch(
  request: Request,
  requireDefinition: boolean,
): Promise<MailRulePatch> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new UnsupportedMediaTypeError();
  const input = await readBoundedJson(request, MAX_RULE_INPUT_BYTES);
  if (!isRecord(input)) throw new ApiInputError('rule input must be an object');
  rejectUnknown(input, [
    'name', 'enabled', 'priority', 'conditions', 'actions',
    'applyExisting', 'applyIncoming', 'stopProcessing',
  ]);
  const result: MailRulePatch = {};
  readString(input, result, 'name');
  readNumber(input, result, 'priority');
  for (const field of ['enabled', 'applyExisting', 'applyIncoming', 'stopProcessing'] as const) {
    readBoolean(input, result, field);
  }
  if (input.conditions !== undefined) result.conditions = readConditions(input.conditions);
  if (input.actions !== undefined) result.actions = readActions(input.actions);
  if (Object.keys(result).length === 0) throw new ApiInputError('rule patch is empty');
  if (requireDefinition) {
    for (const field of [
      'name', 'enabled', 'priority', 'conditions', 'actions',
      'applyExisting', 'applyIncoming', 'stopProcessing',
    ]) {
      if (!(field in result)) throw new ApiInputError(`${field} is required`);
    }
  }
  return result;
}

function readConditions(value: unknown): Partial<MailRuleConditions> {
  if (!isRecord(value)) throw new ApiInputError('conditions must be an object');
  const allowed = [
    'fromContains', 'toContains', 'subjectContains', 'participantDomain', 'keyword',
    'attachment', 'minimumBytes', 'maximumBytes', 'direction',
  ];
  rejectUnknown(value, allowed);
  const result: Record<string, unknown> = {};
  for (const field of [
    'fromContains', 'toContains', 'subjectContains', 'participantDomain',
    'keyword', 'attachment', 'direction',
  ]) readString(value, result, field);
  for (const field of ['minimumBytes', 'maximumBytes']) {
    const item = value[field];
    if (item !== undefined && item !== null && typeof item !== 'number') {
      throw new ApiInputError(`${field} must be a number or null`);
    }
    if (item !== undefined) result[field] = item;
  }
  return result as Partial<MailRuleConditions>;
}

function readActions(value: unknown): Partial<MailRuleActions> {
  if (!isRecord(value)) throw new ApiInputError('actions must be an object');
  rejectUnknown(value, ['star', 'archive', 'trash', 'labelIds']);
  const result: Record<string, unknown> = {};
  for (const field of ['star', 'archive', 'trash']) readBoolean(value, result, field);
  if (value.labelIds !== undefined) {
    if (!Array.isArray(value.labelIds) || value.labelIds.length > 10
      || value.labelIds.some((item) => typeof item !== 'string')) {
      throw new ApiInputError('actions.labelIds must contain at most 10 strings');
    }
    result.labelIds = value.labelIds;
  }
  return result as Partial<MailRuleActions>;
}

function readString(input: Record<string, unknown>, output: Record<string, unknown>, field: string) {
  const value = input[field];
  if (value === undefined) return;
  if (typeof value !== 'string') throw new ApiInputError(`${field} must be a string`);
  output[field] = value;
}

function readBoolean(input: Record<string, unknown>, output: Record<string, unknown>, field: string) {
  const value = input[field];
  if (value === undefined) return;
  if (typeof value !== 'boolean') throw new ApiInputError(`${field} must be boolean`);
  output[field] = value;
}

function readNumber(input: Record<string, unknown>, output: Record<string, unknown>, field: string) {
  const value = input[field];
  if (value === undefined) return;
  if (typeof value !== 'number') throw new ApiInputError(`${field} must be a number`);
  output[field] = value;
}

function rejectUnknown(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new ApiInputError('rule input contains an unknown field');
  }
}
