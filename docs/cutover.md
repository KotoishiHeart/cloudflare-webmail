# Archived-to-rebuild production cutover

This runbook switches `cloudflare-webmail-archived` to the separated Web,
Ingest, and Jobs Workers. It assumes migration rehearsal, a dedicated canary
hostname/address, and a change window. Do not use the first production attempt
as the migration rehearsal.

The irreversible boundary is the production Email Routing change: mail
accepted by the new Ingest Worker exists only in the new D1/R2 resources. A
routing rollback stops additional mail from entering the rebuild, but it does
not copy the already accepted interval back into the archived system.

## 1. Record the approved scope

Before the window, record all of the following in the change ticket:

- Exact Git commit and deployment `planId`.
- Archived D1 and R2 resource names; new D1, R2, Queue, and Worker names.
- Account-to-mailbox mapping digest and every explicit exclusion.
- Generated provisioning-review digest and the disposition of every account
  policy, domain, external alias, and legacy membership suggestion.
- Successful legacy provisioning-verification digest binding the exact
  provisioning and deployment manifests.
- Access application/policy, production and canary hostnames, and canary mail
  address.
- Current production Email Routing rule and its archived Worker target.
- Operators authorized to change Access, Email Routing, Workers, D1, and R2.
- A credential-retirement record for every archived SMTP/provider, API, R2,
  Access service-token, and migration credential: owner, provider-side
  identifier, planned revocation time, and replacement if still required.
- Abort deadline, observation period, and the person making the go/no-go call.

Keep the archived resources intact and disable all retention runs in the new
system for the whole cutover and observation period.

## 2. Rehearse on the separated deployment

Deploy the rebuild on its canary hostname with the review-first process in
[`deployment.md`](deployment.md). Provision every mapped user, Access identity,
mailbox, address, membership, and system administrator before migration.
Generate the initial directory from the archived mapping, then resolve its
separate policy review as described in
[`legacy-migration.md`](legacy-migration.md); do not grant access from an
archived email address alone.

Apply a recent archived snapshot using [`legacy-migration.md`](legacy-migration.md),
then run:

```bash
npm run migrate:legacy -- bulk-audit \
  --stage ops/legacy-rehearsal-stage \
  --tree ops/legacy-rehearsal-r2-upload \
  --rclone-destination cf-r2:cf-webmail-raw \
  --rclone-config /secure/rclone.conf \
  --database cf-webmail --remote \
  --config ops/deploy-canary/configs/web.wrangler.json \
  --report ops/evidence/rehearsal-r2-check.txt \
  --output ops/evidence/rehearsal-legacy-audit.json

npm run deploy -- postflight --stage ops/deploy-canary
```

Route only the dedicated canary address to the new Ingest Worker. Confirm in
the Web UI and administration event views that a unique inbound test with text,
HTML, Unicode headers, and an attachment is stored once and is downloadable.
Send a unique outbound reply with an attachment; confirm one recipient copy,
thread headers, attachment hash, and SPF/DKIM/DMARC alignment. Test reader,
operator, owner, and system-administrator denial boundaries with real Access
identities. Resolve every postflight blocker before approving the window.

## 3. Start the production window

1. Save screenshots or an API export of the current Access, Email Routing, and
   Custom Domain configuration. Record the exact UTC/JST boundary time.
2. Disable archived Web compose/mutations by changing its Access policy. Do
   not delete the archived Worker or data.
3. Wait for archived outbound sends to finish and confirm no operator is still
   changing archived mail state.
4. Create and verify a fresh portable backup of the new D1/R2 target. Retain
   the earlier archived safe D1 export and complete archived R2 backup too.
5. Generate the production deployment stage from the approved clean commit,
   run preflight, and deploy. Keep the generated `rollback-plan.json`.
6. Run postflight. A nonzero exit or `cutoverReady: false` is an abort; do not
   change production Email Routing.

The production Web Custom Domain may move during step 5. Verify interactive
Access login and mailbox scoping again, but keep normal users denied until the
final archived import and audit finish.

## 4. Establish the mail boundary and final import

Change the production Email Routing rule from the archived Email Worker to the
new Ingest Worker and record the Cloudflare change time. Do not change MX
records: both implementations use Cloudflare Email Routing, and the Worker
target is the controlled boundary.

Immediately after that rule change, the archived store is frozen for inbound
mail. Create a final archived safe D1 export and R2 snapshot, using new paths.
Repeat import, inventory, mapping validation, snapshot verification, stage
preparation, stage verification, and `bulk-apply`. A full second snapshot is
allowed: deterministic message IDs make existing mail idempotent, while the
new migration batch supplies a complete final count comparison.

Run a fresh read-only final audit:

```bash
npm run migrate:legacy -- bulk-audit \
  --stage ops/legacy-final-stage \
  --tree ops/legacy-final-r2-upload \
  --rclone-destination cf-r2:cf-webmail-raw \
  --rclone-config /secure/rclone.conf \
  --database cf-webmail --remote \
  --config ops/deploy-production/configs/web.wrangler.json \
  --report ops/evidence/final-r2-check.txt \
  --output ops/evidence/final-legacy-audit.json

npm run deploy -- postflight --stage ops/deploy-production --force
```

Require `cutoverReady: true`, matching D1 per-account and migrated
configuration counts, a successful download-based R2 comparison, and zero
unexplained migration failures. Confirm the expected labels, default mailbox,
and one migrated incoming rule with an owner identity. Repeat the
inbound/outbound canaries through the production addresses. Then enable normal
users in the new Access policy.

## 5. Observe and retire safely

For at least the approved observation period, monitor delivery events, queue
dead letters, inbound handoffs, storage issues, Email Routing activity, Email
Sending results, and Access authentication. Create and offline-verify a new
portable backup after the final import. Keep retention disabled until that
backup and representative restores/downloads are verified.

Remove archived Access only after the observation period. Keep the archived
Workers disabled but deployable and keep archived D1/R2 read-only for the
approved legal/operational retention period. Deleting old resources is a
separate reviewed change, never part of cutover.

Revoke or rotate every archived third-party and migration credential at the
provider after the observation period, or earlier when the rebuild no longer
needs it. Record provider-side evidence without recording the credential
value. Deleting a plaintext value from a local file is not revocation and does
not close this gate. The rebuild uses Cloudflare Email Service and must not
retain an archived SMTP provider credential.

## Abort and rollback

Before the Email Routing boundary, abort by leaving the archived routing rule
unchanged. If the new Worker code itself is faulty after deployment, restore
its recorded versions with:

```bash
npm run deploy -- rollback \
  --stage ops/deploy-production \
  --reason "describe the failed acceptance check" \
  --yes
```

This does not revert D1/R2 or Cloudflare configuration. Restore Access, Custom
Domain, and Email Routing explicitly from the recorded configuration.

After the Email Routing boundary, first direct new mail back to the archived
Worker only if the new ingress cannot safely accept mail. Keep both Web UIs
closed to normal users, back up the new D1/R2 immediately, and identify every
message accepted after the boundary from inbound handoffs and delivery events.
Those interval messages must be reconciled before reopening the archived UI;
this repository intentionally has no automatic reverse importer that could
silently overwrite archived data. Preserve both stores and escalate rather
than deleting or editing mail to make counts appear equal.
