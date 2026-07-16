import type { AccessIdentityKey } from './domain.js';
import {
  DatabaseInputError,
  normalizeId,
  normalizeIssuer,
  normalizeSubject,
  requireTimestamp,
} from './validation.js';
import type { WebMailboxFolder } from './web-message-domain.js';
import { isWebMailboxFolder } from './web-message-list.js';

export type UserPreferences = {
  theme: 'system' | 'light' | 'dark';
  pageSize: number;
  defaultFolder: WebMailboxFolder;
  defaultMailboxId: string | null;
  showHtmlByDefault: boolean;
  compactLayout: boolean;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  theme: 'system',
  pageSize: 30,
  defaultFolder: 'inbox',
  defaultMailboxId: null,
  showHtmlByDefault: true,
  compactLayout: false,
};

type PreferenceRow = {
  theme: string;
  page_size: number;
  default_folder: string;
  default_mailbox_id: string | null;
  show_html_by_default: number;
  compact_layout: number;
};

export async function getUserPreferences(
  db: D1Database,
  identity: AccessIdentityKey,
): Promise<{ userId: string; preferences: UserPreferences } | null> {
  const userId = await userIdForIdentity(db, identity);
  if (userId === null) return null;
  const row = await db.prepare(`
    SELECT p.theme, p.page_size, p.default_folder,
      CASE WHEN m.id IS NULL THEN NULL ELSE p.default_mailbox_id END AS default_mailbox_id,
      p.show_html_by_default, p.compact_layout
    FROM user_preferences AS p
    LEFT JOIN mailbox_memberships AS mm
      ON mm.user_id = p.user_id AND mm.mailbox_id = p.default_mailbox_id
    LEFT JOIN mailboxes AS m ON m.id = mm.mailbox_id AND m.status = 'active'
    WHERE p.user_id = ?
  `).bind(userId).first<PreferenceRow>();
  return { userId, preferences: row === null ? DEFAULT_USER_PREFERENCES : toPreferences(row) };
}

async function userIdForIdentity(
  db: D1Database,
  identity: AccessIdentityKey,
): Promise<string | null> {
  const row = await db.prepare(`
    SELECT u.id FROM access_identities AS ai
    JOIN users AS u ON u.id = ai.user_id AND u.status = 'active'
    WHERE ai.issuer = ? AND ai.subject = ?
    LIMIT 1
  `).bind(
    normalizeIssuer(identity.issuer),
    normalizeSubject(identity.subject),
  ).first<{ id: string }>();
  return row?.id ?? null;
}

export async function saveUserPreferences(
  db: D1Database,
  userIdInput: string,
  preferences: UserPreferences,
  nowInput: number,
): Promise<void> {
  const userId = normalizeId(userIdInput, 'userId');
  const now = requireTimestamp(nowInput);
  validatePreferences(preferences);
  await requireAuthorizedDefaultMailbox(db, userId, preferences.defaultMailboxId);
  await db.prepare(`
    INSERT INTO user_preferences (
      user_id, theme, page_size, default_folder,
      default_mailbox_id, show_html_by_default, compact_layout, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      theme = excluded.theme,
      page_size = excluded.page_size,
      default_folder = excluded.default_folder,
      default_mailbox_id = excluded.default_mailbox_id,
      show_html_by_default = excluded.show_html_by_default,
      compact_layout = excluded.compact_layout,
      updated_at = excluded.updated_at
  `).bind(
    userId,
    preferences.theme,
    preferences.pageSize,
    preferences.defaultFolder,
    preferences.defaultMailboxId,
    preferences.showHtmlByDefault ? 1 : 0,
    preferences.compactLayout ? 1 : 0,
    now,
    now,
  ).run();
}

export function validatePreferences(preferences: UserPreferences): void {
  if (!['system', 'light', 'dark'].includes(preferences.theme)) {
    throw new DatabaseInputError('theme', 'must be system, light, or dark');
  }
  if (!Number.isInteger(preferences.pageSize)
    || preferences.pageSize < 10 || preferences.pageSize > 50) {
    throw new DatabaseInputError('pageSize', 'must be between 10 and 50');
  }
  if (!isWebMailboxFolder(preferences.defaultFolder)) {
    throw new DatabaseInputError('defaultFolder', 'is unsupported');
  }
  if (preferences.defaultMailboxId !== null && typeof preferences.defaultMailboxId !== 'string') {
    throw new DatabaseInputError('defaultMailboxId', 'must be a mailbox ID or null');
  }
  if (typeof preferences.showHtmlByDefault !== 'boolean'
    || typeof preferences.compactLayout !== 'boolean') {
    throw new DatabaseInputError('preferences', 'flags must be boolean');
  }
}

function toPreferences(row: PreferenceRow): UserPreferences {
  const preferences = {
    theme: row.theme,
    pageSize: row.page_size,
    defaultFolder: row.default_folder,
    defaultMailboxId: row.default_mailbox_id,
    showHtmlByDefault: row.show_html_by_default === 1,
    compactLayout: row.compact_layout === 1,
  } as UserPreferences;
  validatePreferences(preferences);
  return preferences;
}

async function requireAuthorizedDefaultMailbox(
  db: D1Database,
  userId: string,
  mailboxId: string | null,
): Promise<void> {
  if (mailboxId === null) return;
  const normalized = normalizeId(mailboxId, 'defaultMailboxId');
  const row = await db.prepare(`
    SELECT 1 AS found FROM mailbox_memberships AS mm
    JOIN mailboxes AS m ON m.id = mm.mailbox_id AND m.status = 'active'
    WHERE mm.user_id = ? AND mm.mailbox_id = ? LIMIT 1
  `).bind(userId, normalized).first<{ found: number }>();
  if (row === null) {
    throw new DatabaseInputError('defaultMailboxId', 'must be an authorized active mailbox');
  }
}
