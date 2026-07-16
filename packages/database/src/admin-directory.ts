export type AdminUserSummary = {
  id: string;
  email: string;
  displayName: string | null;
  status: 'active' | 'disabled';
  isSystemAdmin: boolean;
  identityCount: number;
  mailboxCount: number;
  createdAt: number;
  updatedAt: number;
};

export type AdminMailboxSummary = {
  id: string;
  displayName: string;
  status: 'active' | 'disabled';
  primaryAddress: string | null;
  addressCount: number;
  memberCount: number;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

export async function listAdminUsers(db: D1Database): Promise<AdminUserSummary[]> {
  const result = await db.prepare(`
    SELECT
      u.id, u.email, u.display_name, u.status, u.created_at, u.updated_at,
      CASE WHEN sa.user_id IS NULL THEN 0 ELSE 1 END AS is_system_admin,
      (SELECT COUNT(*) FROM access_identities ai WHERE ai.user_id = u.id) AS identity_count,
      (SELECT COUNT(*) FROM mailbox_memberships mm WHERE mm.user_id = u.id) AS mailbox_count
    FROM users u
    LEFT JOIN system_administrators sa ON sa.user_id = u.id
    ORDER BY u.email COLLATE NOCASE, u.id
    LIMIT 500
  `).all<{
    id: string; email: string; display_name: string | null; status: 'active' | 'disabled';
    is_system_admin: number; identity_count: number; mailbox_count: number;
    created_at: number; updated_at: number;
  }>();
  return result.results.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    isSystemAdmin: row.is_system_admin === 1,
    identityCount: row.identity_count,
    mailboxCount: row.mailbox_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function listAdminMailboxes(db: D1Database): Promise<AdminMailboxSummary[]> {
  const result = await db.prepare(`
    SELECT
      m.id, m.display_name, m.status, m.created_at, m.updated_at,
      (SELECT address FROM mailbox_addresses ma
       WHERE ma.mailbox_id = m.id AND ma.kind = 'primary'
       ORDER BY CASE ma.status WHEN 'active' THEN 0 ELSE 1 END, ma.address LIMIT 1
      ) AS primary_address,
      (SELECT COUNT(*) FROM mailbox_addresses ma WHERE ma.mailbox_id = m.id) AS address_count,
      (SELECT COUNT(*) FROM mailbox_memberships mm WHERE mm.mailbox_id = m.id) AS member_count,
      (SELECT COUNT(*) FROM messages msg WHERE msg.mailbox_id = m.id) AS message_count
    FROM mailboxes m
    ORDER BY COALESCE(primary_address, m.display_name) COLLATE NOCASE, m.id
    LIMIT 500
  `).all<{
    id: string; display_name: string; status: 'active' | 'disabled';
    primary_address: string | null; address_count: number; member_count: number;
    message_count: number; created_at: number; updated_at: number;
  }>();
  return result.results.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    primaryAddress: row.primary_address,
    addressCount: row.address_count,
    memberCount: row.member_count,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getAdminUserDetail(db: D1Database, userId: string) {
  const user = await db.prepare(`
    SELECT u.id, u.email, u.display_name, u.status, u.created_at, u.updated_at,
      CASE WHEN sa.user_id IS NULL THEN 0 ELSE 1 END AS is_system_admin
    FROM users u LEFT JOIN system_administrators sa ON sa.user_id = u.id
    WHERE u.id = ?
  `).bind(userId).first<{
    id: string; email: string; display_name: string | null; status: 'active' | 'disabled';
    created_at: number; updated_at: number; is_system_admin: number;
  }>();
  if (user === null) return null;
  const [identities, memberships] = await Promise.all([
    db.prepare(`
      SELECT issuer, subject, email, created_at, updated_at, last_seen_at
      FROM access_identities WHERE user_id = ? ORDER BY issuer, subject
    `).bind(userId).all<{
      issuer: string; subject: string; email: string; created_at: number;
      updated_at: number; last_seen_at: number;
    }>(),
    db.prepare(`
      SELECT mm.mailbox_id, mm.role, m.display_name, mm.created_at, mm.updated_at
      FROM mailbox_memberships mm JOIN mailboxes m ON m.id = mm.mailbox_id
      WHERE mm.user_id = ? ORDER BY m.display_name COLLATE NOCASE
    `).bind(userId).all<{
      mailbox_id: string; role: string; display_name: string; created_at: number; updated_at: number;
    }>(),
  ]);
  return {
    user: {
      id: user.id, email: user.email, displayName: user.display_name, status: user.status,
      isSystemAdmin: user.is_system_admin === 1,
      createdAt: user.created_at, updatedAt: user.updated_at,
    },
    identities: identities.results.map((identity) => ({
      issuer: identity.issuer, subject: identity.subject, email: identity.email,
      createdAt: identity.created_at, updatedAt: identity.updated_at,
      lastSeenAt: identity.last_seen_at,
    })),
    memberships: memberships.results.map((membership) => ({
      mailboxId: membership.mailbox_id, role: membership.role,
      displayName: membership.display_name,
      createdAt: membership.created_at, updatedAt: membership.updated_at,
    })),
  };
}

export async function getAdminMailboxDetail(db: D1Database, mailboxId: string) {
  const mailbox = await db.prepare(`
    SELECT id, display_name, status, created_at, updated_at FROM mailboxes WHERE id = ?
  `).bind(mailboxId).first<{
    id: string; display_name: string; status: 'active' | 'disabled';
    created_at: number; updated_at: number;
  }>();
  if (mailbox === null) return null;
  const [addresses, members] = await Promise.all([
    db.prepare(`
      SELECT address, kind, status, created_at, updated_at FROM mailbox_addresses
      WHERE mailbox_id = ? ORDER BY kind DESC, address COLLATE NOCASE
    `).bind(mailboxId).all<{
      address: string; kind: string; status: string; created_at: number; updated_at: number;
    }>(),
    db.prepare(`
      SELECT mm.user_id, u.email, u.display_name, u.status, mm.role,
        mm.created_at, mm.updated_at
      FROM mailbox_memberships mm JOIN users u ON u.id = mm.user_id
      WHERE mm.mailbox_id = ? ORDER BY u.email COLLATE NOCASE
    `).bind(mailboxId).all<{
      user_id: string; email: string; display_name: string | null; status: string;
      role: string; created_at: number; updated_at: number;
    }>(),
  ]);
  return {
    mailbox: {
      id: mailbox.id, displayName: mailbox.display_name, status: mailbox.status,
      createdAt: mailbox.created_at, updatedAt: mailbox.updated_at,
    },
    addresses: addresses.results.map((address) => ({
      address: address.address, kind: address.kind, status: address.status,
      createdAt: address.created_at, updatedAt: address.updated_at,
    })),
    members: members.results.map((member) => ({
      userId: member.user_id, email: member.email, displayName: member.display_name,
      status: member.status, role: member.role,
      createdAt: member.created_at, updatedAt: member.updated_at,
    })),
  };
}

export async function getAdminSummary(
  db: D1Database,
  now: number,
): Promise<Record<string, number>> {
  const row = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE status = 'active') AS active_users,
      (SELECT COUNT(*) FROM system_administrators sa JOIN users u ON u.id = sa.user_id
       WHERE u.status = 'active') AS active_administrators,
      (SELECT COUNT(*) FROM mailboxes WHERE status = 'active') AS active_mailboxes,
      (SELECT COUNT(*) FROM mailbox_addresses WHERE status = 'active') AS active_addresses,
      (SELECT COUNT(*) FROM messages) AS messages,
      (SELECT COUNT(*) FROM delivery_events
       WHERE status IN ('failed', 'rejected') AND created_at >= ?) AS failed_delivery_events_7d
  `).bind(now - 7 * 86_400_000).first<Record<string, number>>();
  return row ?? {};
}
