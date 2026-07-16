import {
  isMailboxAddressKind,
  type MailboxRoute,
} from './domain.js';
import { normalizeEmailAddress } from './validation.js';

export type MailboxRouteRow = {
  mailbox_id: string;
  address: string;
  address_kind: string;
  primary_address: string;
  display_name: string;
};

export async function resolveActiveMailboxAddress(
  db: D1Database,
  addressInput: string,
): Promise<MailboxRoute | null> {
  const address = normalizeEmailAddress(addressInput, 'address');
  const row = await db.prepare(`
    SELECT
      m.id AS mailbox_id,
      ma.address,
      ma.kind AS address_kind,
      primary_address.address AS primary_address,
      m.display_name
    FROM mailbox_addresses AS ma
    JOIN mailboxes AS m ON m.id = ma.mailbox_id
    JOIN mailbox_addresses AS primary_address
      ON primary_address.mailbox_id = m.id
      AND primary_address.kind = 'primary'
      AND primary_address.status = 'active'
    WHERE ma.address = ? COLLATE NOCASE
      AND ma.status = 'active'
      AND m.status = 'active'
    LIMIT 1
  `).bind(address).first<MailboxRouteRow>();

  return row === null ? null : toMailboxRoute(row);
}

export function toMailboxRoute(row: MailboxRouteRow): MailboxRoute {
  if (!isMailboxAddressKind(row.address_kind)) {
    throw new Error('D1 returned an invalid mailbox address kind');
  }
  return {
    mailboxId: row.mailbox_id,
    address: row.address,
    addressKind: row.address_kind,
    primaryAddress: row.primary_address,
    displayName: row.display_name,
  };
}
