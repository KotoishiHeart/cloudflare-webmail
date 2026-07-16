import type { MailRuleActions, MailRuleConditions } from './mail-rule-domain.js';

export type MailRuleRunMode = 'preview' | 'apply_existing' | 'incoming' | 'undo';
export type MailRuleRunStatus =
  | 'running'
  | 'ready'
  | 'completed'
  | 'applied'
  | 'blocked'
  | 'failed'
  | 'undone';

export type MailRuleRun = {
  id: string;
  mailboxId: string;
  ruleId: string;
  ruleName: string;
  ruleVersion: number;
  mode: MailRuleRunMode;
  status: MailRuleRunStatus;
  conditions: MailRuleConditions;
  actions: MailRuleActions;
  sourceRunId: string | null;
  targetMessageId: string | null;
  matchedCount: number;
  changedCount: number;
  summary: string;
  createdAt: number;
  completedAt: number | null;
};

export type MailRuleRunMatch = {
  messageId: string;
  subject: string;
  sender: string;
  receivedAt: number;
  rawSize: number;
  attachmentCount: number;
};

export type RuleMessageState = {
  isStarred: boolean;
  isArchived: boolean;
  isDeleted: boolean;
  labelIds: string[];
};
