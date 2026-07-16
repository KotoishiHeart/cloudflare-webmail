import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateProvisionManifest } from './ops-manifest.mjs';
import { readLegacyImportMetadata } from './legacy-sqlite.mjs';

export function createLegacyProvisioningDraft(options) {
  const database = new DatabaseSync(resolve(options.database), { readOnly: true });
  try {
    const source = readLegacyImportMetadata(database);
    const accounts = accountRows(database);
    const accountByAddress = new Map(accounts.map((account) => [account.address, account]));
    const mailboxByAddress = new Map(
      options.mapping.mappings.map((mapping) => [mapping.sourceAddress, mapping]),
    );
    const mailboxAliases = new Map(
      options.mapping.mappings.map((mapping) => [mapping.mailboxId, []]),
    );
    const defaultFrom = legacyDefaultFrom(database, mailboxByAddress);
    const externalAliases = [];
    for (const alias of aliasRows(database)) {
      const decision = classifyAlias(alias, mailboxByAddress);
      if (decision.mailboxId === null) {
        externalAliases.push({ ...alias, reason: decision.reason });
      } else {
        mailboxAliases.get(decision.mailboxId).push(alias.source);
      }
    }
    const manifest = validateProvisionManifest({
      version: 1,
      users: [{
        id: options.owner.userId,
        email: options.owner.email,
        displayName: options.owner.displayName,
        systemAdmin: options.owner.systemAdmin,
        defaultMailboxId: defaultFrom.mailboxId ?? undefined,
        identities: [{
          issuer: options.owner.issuer,
          subject: options.owner.subject,
          email: options.owner.email,
        }],
      }],
      mailboxes: options.mapping.mappings.map((mapping) => {
        const account = accountByAddress.get(mapping.sourceAddress);
        return {
          id: mapping.mailboxId,
          address: mapping.address,
          displayName: account?.displayName || mapping.address,
          ownerUserId: options.owner.userId,
          aliases: mailboxAliases.get(mapping.mailboxId),
          members: [],
        };
      }),
    });
    const review = {
      version: 1,
      kind: 'cf-webmail-legacy-provisioning-review',
      createdAt: options.now ?? Date.now(),
      sourceDatabaseSha256: source.sourceSha256,
      mappingSha256: options.mappingSha256,
      generated: {
        mailboxes: manifest.mailboxes.length,
        aliases: manifest.mailboxes.reduce((count, mailbox) => count + mailbox.aliases.length, 0),
      },
      defaultFrom,
      accountPolicies: options.mapping.mappings.map((mapping) => {
        const account = accountByAddress.get(mapping.sourceAddress);
        return {
          sourceAddress: mapping.sourceAddress,
          mailboxId: mapping.mailboxId,
          active: account?.active ?? false,
          allowReceive: account?.allowReceive ?? false,
          allowSend: account?.allowSend ?? false,
          addressKind: account?.addressKind ?? 'unknown',
          action: 'review mailbox/address status and Email Routing policy',
        };
      }),
      externalAliases,
      domains: domainRows(database),
      membershipSuggestions: membershipRows(database, mailboxByAddress),
      manualChecks: [
        'Confirm the generated owner and every mailbox ownership assignment.',
        'Confirm the archived default From mailbox assigned to the generated owner.',
        'Recreate external/forward/quarantine/log-only aliases in Email Routing policy.',
        'Map each membership suggestion to a provisioned Access issuer and subject before granting it.',
        'Confirm send-only, receive-only, disabled, and quarantine account behavior outside the primary-address model.',
      ],
    };
    return { manifest, review };
  } finally {
    database.close();
  }
}

function legacyDefaultFrom(database, mailboxByAddress) {
  if (!table(database, 'app_settings')) {
    return { configured: false, sourceAddress: null, mailboxId: null };
  }
  const row = database.prepare("SELECT value FROM app_settings WHERE key = 'default_from'").get();
  const sourceAddress = String(row?.value ?? '').trim().toLowerCase();
  if (sourceAddress === '') return { configured: false, sourceAddress: null, mailboxId: null };
  return {
    configured: true,
    sourceAddress: email(sourceAddress, 'legacy default From'),
    mailboxId: mailboxByAddress.get(sourceAddress)?.mailboxId ?? null,
  };
}

function accountRows(database) {
  return database.prepare(`
    SELECT LOWER(email) AS address, display_name, is_active,
      allow_receive, allow_send, address_kind
    FROM mail_accounts ORDER BY LOWER(email)
  `).all().map((row) => ({
    address: String(row.address),
    displayName: cleanText(row.display_name, 160),
    active: Number(row.is_active) === 1,
    allowReceive: Number(row.allow_receive ?? 1) === 1,
    allowSend: Number(row.allow_send ?? 1) === 1,
    addressKind: cleanText(row.address_kind, 64) || 'mailbox',
  }));
}

function aliasRows(database) {
  if (!table(database, 'mail_aliases')) return [];
  return database.prepare(`
    SELECT id, source, destination, is_active, alias_kind, notes
    FROM mail_aliases ORDER BY LOWER(source), id
  `).all().map((row) => ({
    sourceId: String(row.id),
    source: email(row.source, 'legacy alias source'),
    destination: cleanText(row.destination, 2048),
    active: Number(row.is_active) === 1,
    aliasKind: cleanText(row.alias_kind, 64) || 'alias',
    notes: cleanText(row.notes, 240),
  }));
}

function classifyAlias(alias, mailboxByAddress) {
  if (!alias.active) return { mailboxId: null, reason: 'disabled legacy alias' };
  if (!['alias', 'representative'].includes(alias.aliasKind)) {
    return { mailboxId: null, reason: `external policy kind: ${alias.aliasKind}` };
  }
  if (mailboxByAddress.has(alias.source)) {
    return { mailboxId: null, reason: 'source conflicts with a mapped primary address' };
  }
  const targets = new Set(destinationAddresses(alias.destination)
    .map((address) => mailboxByAddress.get(address)?.mailboxId).filter(Boolean));
  if (targets.size !== 1) {
    return { mailboxId: null, reason: targets.size === 0
      ? 'no mapped local destination' : 'multiple mapped local destinations' };
  }
  return { mailboxId: [...targets][0], reason: '' };
}

function domainRows(database) {
  if (!table(database, 'mail_domains')) return [];
  return database.prepare(`
    SELECT domain, is_active, routing_status, dns_status, inbound_policy, notes
    FROM mail_domains ORDER BY LOWER(domain)
  `).all().map((row) => ({
    domain: cleanText(row.domain, 253).toLowerCase(),
    active: Number(row.is_active) === 1,
    routingStatus: cleanText(row.routing_status, 64),
    dnsStatus: cleanText(row.dns_status, 64),
    inboundPolicy: cleanText(row.inbound_policy, 64) || 'reject',
    notes: cleanText(row.notes, 240),
    action: 'verify current Cloudflare Email Routing, DNS, SPF, DKIM, and DMARC state',
  }));
}

function membershipRows(database, mailboxByAddress) {
  if (!table(database, 'mail_account_users')) return [];
  return database.prepare(`
    SELECT account_email, access_email, role, can_send, is_active
    FROM mail_account_users ORDER BY LOWER(access_email), LOWER(account_email)
  `).all().map((row) => {
    const sourceAddress = email(row.account_email, 'legacy membership account');
    return {
      sourceAddress,
      mailboxId: mailboxByAddress.get(sourceAddress)?.mailboxId ?? null,
      accessEmail: email(row.access_email, 'legacy membership user'),
      legacyRole: cleanText(row.role, 32) || 'user',
      canSend: Number(row.can_send ?? 1) === 1,
      active: Number(row.is_active) === 1,
      suggestedRole: Number(row.is_active) !== 1 || !mailboxByAddress.has(sourceAddress)
        ? null : row.role === 'owner' ? 'owner'
          : row.role === 'read-only' || Number(row.can_send) !== 1 ? 'viewer' : 'operator',
    };
  });
}

function destinationAddresses(value) {
  return String(value ?? '').split(',').map((part) => {
    const bracket = part.match(/<([^<>]+)>/u)?.[1];
    return String(bracket ?? part).trim().toLowerCase();
  }).filter((address) => /^[^@\s]+@[^@\s]+$/u.test(address));
}

function email(value, name) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/u.test(normalized) || normalized.length > 320) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function cleanText(value, maximum) {
  return String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ').slice(0, maximum);
}

function table(database, name) {
  return database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;
}
