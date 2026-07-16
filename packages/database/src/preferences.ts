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
  showHtmlByDefault: boolean;
  compactLayout: boolean;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  theme: 'system',
  pageSize: 30,
  defaultFolder: 'inbox',
  showHtmlByDefault: true,
  compactLayout: false,
};

type PreferenceRow = {
  theme: string;
  page_size: number;
  default_folder: string;
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
    SELECT theme, page_size, default_folder, show_html_by_default, compact_layout
    FROM user_preferences WHERE user_id = ?
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
  await db.prepare(`
    INSERT INTO user_preferences (
      user_id, theme, page_size, default_folder,
      show_html_by_default, compact_layout, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      theme = excluded.theme,
      page_size = excluded.page_size,
      default_folder = excluded.default_folder,
      show_html_by_default = excluded.show_html_by_default,
      compact_layout = excluded.compact_layout,
      updated_at = excluded.updated_at
  `).bind(
    userId,
    preferences.theme,
    preferences.pageSize,
    preferences.defaultFolder,
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
    showHtmlByDefault: row.show_html_by_default === 1,
    compactLayout: row.compact_layout === 1,
  } as UserPreferences;
  validatePreferences(preferences);
  return preferences;
}
