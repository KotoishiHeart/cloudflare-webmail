import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateDeploymentManifest } from './deploy-manifest.mjs';
import {
  createLegacyInventory,
  legacyMappingSha256,
  loadAndValidateLegacyMapping,
} from './legacy-inventory.mjs';
import { validateProvisionManifest } from './ops-manifest.mjs';
import { createLegacyProvisioningDraft } from './legacy-provisioning.mjs';

export async function verifyLegacyProvisioningFiles(options) {
  const inventory = createLegacyInventory(options.database);
  const mapping = await loadAndValidateLegacyMapping(options.mapping, inventory);
  const mappingSha256 = legacyMappingSha256(mapping);
  const [manifestText, reviewText, deploymentText] = await Promise.all([
    readFile(options.manifest, 'utf8'),
    readFile(options.review, 'utf8'),
    readFile(options.deployment, 'utf8'),
  ]);
  const manifest = validateProvisionManifest(JSON.parse(manifestText));
  const review = JSON.parse(reviewText);
  const deployment = validateDeploymentManifest(JSON.parse(deploymentText));
  const result = verifyLegacyProvisioning({
    database: options.database,
    mapping,
    mappingSha256,
    manifest,
    review,
    deployment,
    now: options.now,
  });
  return {
    ...result,
    artifacts: {
      manifestSha256: sha256(manifestText),
      reviewSha256: sha256(reviewText),
      deploymentSha256: sha256(deploymentText),
    },
  };
}

export function verifyLegacyProvisioning(options) {
  const owner = firstOwner(options.manifest);
  const expected = createLegacyProvisioningDraft({
    database: options.database,
    mapping: options.mapping,
    mappingSha256: options.mappingSha256,
    owner,
    now: options.review.createdAt,
  });
  verifyReview(options.review, expected.review);
  verifyStandardAccounts(expected.review.accountPolicies);
  if (expected.review.externalAliases.length > 0) {
    throw new Error('provisioning review has external aliases that require verified routing evidence');
  }

  const users = new Map(options.manifest.users.map((user) => [user.id, user]));
  const usersByEmail = new Map(options.manifest.users.map((user) => [user.email, user]));
  const mailboxes = new Map(options.manifest.mailboxes.map((mailbox) => [mailbox.id, mailbox]));
  const expectedMailboxes = new Map(
    expected.manifest.mailboxes.map((mailbox) => [mailbox.id, mailbox]),
  );
  const routingDomains = new Set(options.deployment.email.routingDomains);
  const sendingDomains = new Set(options.deployment.email.sendingDomains);
  const teamIssuer = options.deployment.access.teamDomain;
  let aliases = 0;
  for (const mapping of options.mapping.mappings) {
    const mailbox = mailboxes.get(mapping.mailboxId);
    if (mailbox?.address !== mapping.address) {
      throw new Error('provision manifest does not exactly cover every mapped mailbox and address');
    }
    const ownerUser = users.get(mailbox.ownerUserId);
    requireTeamIdentity(ownerUser, teamIssuer, 'mapped mailbox owner');
    requireDomain(mapping.address, routingDomains, 'Email Routing');
    requireDomain(mapping.address, sendingDomains, 'Email Sending');
    for (const alias of expectedMailboxes.get(mapping.mailboxId)?.aliases ?? []) {
      if (!mailbox.aliases.includes(alias)) {
        throw new Error('provision manifest is missing a generated local alias');
      }
      requireDomain(alias, routingDomains, 'Email Routing');
      aliases += 1;
    }
  }
  const systemAdministrators = options.manifest.users.filter((user) => user.systemAdmin);
  if (systemAdministrators.length < 1) {
    throw new Error('provision manifest requires at least one system administrator');
  }
  for (const user of systemAdministrators) {
    requireTeamIdentity(user, teamIssuer, 'system administrator');
  }
  const memberships = verifyMemberships(
    expected.review.membershipSuggestions,
    usersByEmail,
    mailboxes,
    teamIssuer,
  );
  return {
    version: 1,
    kind: 'cf-webmail-legacy-provisioning-verification',
    verifiedAt: options.now ?? Date.now(),
    sourceDatabaseSha256: expected.review.sourceDatabaseSha256,
    mappingSha256: options.mappingSha256,
    ready: true,
    counts: {
      users: options.manifest.users.length,
      mailboxes: options.mapping.mappings.length,
      aliases,
      resolvedMemberships: memberships.resolved,
      ignoredInactiveMemberships: memberships.ignored,
      routingDomains: routingDomains.size,
      sendingDomains: sendingDomains.size,
    },
  };
}

function verifyReview(actual, expected) {
  if (
    actual?.version !== 1
    || actual?.kind !== 'cf-webmail-legacy-provisioning-review'
    || !Number.isSafeInteger(actual.createdAt)
    || actual.createdAt < 1
  ) throw new Error('legacy provisioning review is invalid');
  for (const key of [
    'sourceDatabaseSha256', 'mappingSha256', 'generated', 'accountPolicies',
    'externalAliases', 'domains', 'membershipSuggestions', 'manualChecks',
  ]) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) {
      throw new Error(`legacy provisioning review mismatch: ${key}`);
    }
  }
}

function verifyStandardAccounts(policies) {
  const incompatible = policies.filter((policy) => (
    !policy.active
    || !policy.allowReceive
    || !policy.allowSend
    || policy.addressKind !== 'mailbox'
  ));
  if (incompatible.length > 0) {
    throw new Error(`${incompatible.length} legacy account policy item(s) require explicit routing resolution`);
  }
}

function verifyMemberships(suggestions, usersByEmail, mailboxes, issuer) {
  let resolved = 0;
  let ignored = 0;
  for (const suggestion of suggestions) {
    if (!suggestion.active || suggestion.mailboxId === null) {
      ignored += 1;
      continue;
    }
    const user = usersByEmail.get(suggestion.accessEmail);
    requireTeamIdentity(user, issuer, 'legacy membership');
    const mailbox = mailboxes.get(suggestion.mailboxId);
    const role = mailbox?.ownerUserId === user.id
      ? 'owner'
      : mailbox?.members.find((member) => member.userId === user.id)?.role;
    if (role !== suggestion.suggestedRole) {
      throw new Error('an active legacy membership suggestion is not resolved in the manifest');
    }
    resolved += 1;
  }
  return { resolved, ignored };
}

function requireTeamIdentity(user, issuer, label) {
  if (user === undefined || !user.identities.some((identity) => identity.issuer === issuer)) {
    throw new Error(`${label} has no identity for the deployment Access issuer`);
  }
}

function requireDomain(address, domains, label) {
  const domain = address.slice(address.lastIndexOf('@') + 1);
  if (!domains.has(domain)) throw new Error(`${label} does not include every provisioned domain`);
}

function firstOwner(manifest) {
  const user = manifest.users[0];
  const identity = user?.identities[0];
  if (user === undefined || identity === undefined) {
    throw new Error('provision manifest contains no Access-backed owner');
  }
  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    issuer: identity.issuer,
    subject: identity.subject,
    systemAdmin: user.systemAdmin,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
