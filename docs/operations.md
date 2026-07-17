# Operations runbook

The repository does not create or deploy remote Cloudflare resources by
default. Run every mutating command from the repository root, review generated
SQL first, and select `--local` or `--remote` explicitly.

## One-time Cloudflare resources

Create the resources declared by the committed Worker configurations:

```bash
npx wrangler d1 create cf-webmail
npx wrangler r2 bucket create cf-webmail-raw
npx wrangler queues create cf-webmail-v2-inbound
npx wrangler queues create cf-webmail-v2-inbound-dlq
npx wrangler queues create cf-webmail-v2-outbound
npx wrangler queues create cf-webmail-v2-outbound-dlq
```

All four Queue names must be new and unbound. Do not reuse a Queue attached to
the archived Worker, even when its name looks generic. Initial deployment
preflight rejects any producer or consumer binding; upgrade preflight rejects
bindings owned by a Worker outside the reviewed three-Worker deployment.

Put the returned D1 `database_id`, Cloudflare account ID, and resource names in
an ignored deployment manifest as described in [`deployment.md`](deployment.md).
The deployment tool generates all three production configurations, avoiding
independent binding edits. Verify each sender domain in SMTP2GO, publish its
SPF/DKIM records, and create a new API key restricted to `/email/send` before
enabling outbound delivery. Do not reuse the archived key. Configure Cloudflare
Access for the Web hostname and put its team domain and audience tag in the
same deployment manifest.

## Migrations

Preview locally first, then apply remotely only after a backup:

```bash
npm run ops -- migrate --local --yes
npm run ops -- migrate --remote --yes \
  --config ops/deploy-production/configs/web.wrangler.json
```

The `--yes` flag confirms that the command changes D1; it does not bypass a
Wrangler or Cloudflare authentication prompt.

## Users, Access identities, and mailboxes

Copy `tools/examples/provision.v1.json` outside the tracked tree (the `/ops/`
directory is ignored), replace every example value, and keep the generated
UUIDs stable. A manifest may contain up to 100 users and mailboxes. Each user
must have at least one exact Access issuer/subject pair.

An optional user `defaultMailboxId` creates or updates only that user's default
mailbox preference. It must reference a mailbox in the same manifest where the
user is the owner or an explicit member. Omitting it leaves an existing
preference unchanged; `null` explicitly clears the default.

Set `systemAdmin: true` only on users who should access cross-mailbox
administration, delivery diagnostics, and audit data. Mailbox `owner` grants
do not imply this global role. Provision plans add explicit administrator
grants but do not revoke an existing grant merely because a later manifest
omits or sets the flag to false; revocation is a separately audited operation.

Generate and review an idempotent SQL plan:

```bash
npm run ops -- plan \
  --manifest ops/provision.json \
  --output ops/provision.sql
```

Apply the reviewed file:

```bash
npm run ops -- apply --plan ops/provision.sql --local --yes
npm run ops -- apply --plan ops/provision.sql --remote --yes \
  --config ops/deploy-production/configs/web.wrangler.json
```

The SQL intentionally does not move an existing Access identity to another
user or an existing address to another mailbox. Such ownership changes require
an explicit, separately reviewed migration. A conflicting unique email or ID
therefore stops the plan instead of silently merging accounts.

For an archived deployment, `migrate:legacy provision-template` can generate
this manifest from the reviewed account mapping. Its companion review report
keeps directional account policy, external aliases, domains, and legacy
membership suggestions outside automatic authorization. Follow
[`legacy-migration.md`](legacy-migration.md) and require a successful
`verify-provisioning` artifact before planning or applying it.

## Status and delivery recovery

The status command returns aggregate counts and no message content or email
addresses:

```bash
npm run ops -- status --local
npm run ops -- status --remote \
  --config ops/deploy-production/configs/web.wrangler.json
```

The five-minute jobs cron incrementally compares D1 object references with R2,
scans the canonical `mailboxes/` prefix for unreferenced objects, and scans the
`staging/raw/` prefix for interrupted handoffs. It records findings without
deleting canonical or incomplete staging data. List the latest 100 open
findings with:

```bash
npm run ops -- storage-issues --remote \
  --config ops/deploy-production/configs/web.wrangler.json
```

Missing canonical objects must be restored from a verified backup. Treat
unreferenced canonical objects as review candidates only; a later retention or
hard-delete operation must perform deletion explicitly. Valid raw/contract
staging pairs without a D1 handoff are re-enqueued automatically, while invalid
or incomplete pairs remain in R2 with an open issue.

Primary and dead-letter consumers distinguish D1 Free daily-quota errors from
ordinary transient and permanent failures. A daily-quota error is delayed
until 00:00 UTC plus a short reset allowance, capped at Cloudflare Queues'
24-hour per-message delay. Other transient failures use 30-second exponential
backoff capped at one hour. Storage-capacity errors are not misclassified as a
daily reset condition; they require capacity cleanup, sharding, or a plan
change. If the configured primary retry count is still exhausted, the normal
persisted DLQ workflow remains the recovery boundary.

After fixing a terminal sender-domain, recipient, or content error, explicitly
reset one failed message. This does not send synchronously; the scheduled jobs
recovery republishes it to the outbound Queue:

```bash
npm run ops -- retry-outbound \
  --message-id 019c315c-1f20-7000-8000-000000000000 \
  --remote --yes \
  --config ops/deploy-production/configs/web.wrangler.json
```

Do not retry a message whose provider outcome was ambiguous without first
checking SMTP2GO Activity, because a second delivery can be visible to the
recipient.

The status output also includes unresolved inbound handoffs, staging cleanup
work, and DLQ states. Inspect the selected `queue_dead_letters` row directly in
D1 before requesting a retry. Invalid contracts are retained with
`payload_valid = 0` and cannot be retried by this command.

```bash
npm run ops -- retry-dead-letter \
  --dead-letter-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --remote --yes \
  --config ops/deploy-production/configs/web.wrangler.json
```

The CLI changes the row to `retry_requested`; it never publishes a Queue
message itself. The jobs cron validates the saved contract, publishes it to the
original inbound or outbound Queue, and changes the row to `requeued`. A
successful primary consumer changes it to `resolved`. If Queue publication is
ambiguous, the row stays requested and a later run may publish a duplicate;
both primary processors are idempotent by message ID.

The same five-minute Cron bounds operational history independently from mail
retention. It removes at most 500 delivery events older than 90 days and at
most 500 audit events older than 365 days per run. Failures are isolated from
queue recovery, storage audit, and approved mail-retention work. These fixed
periods apply only to diagnostic event rows; they never delete messages or R2
objects.

## Retention and permanent deletion

Retention is off for every new mailbox. A system administrator must configure
and enable the mailbox policy in the administration API or UI. Keep starred and
labeled exclusions enabled unless a separately approved data policy requires
otherwise.

Permanent deletion follows this fixed sequence:

1. Create a retention preview for one mailbox and review every frozen item.
2. Create and verify a fresh portable backup after the preview.
3. Record the manifest digest with `sha256sum <backup>/manifest.json`.
4. Approve the preview using the backup path/reference, digest, creation time,
   and the exact `BACKUP_VERIFIED` confirmation.
5. Monitor the retention run and delivery events until it is `completed`.
6. If it is `failed`, preserve the backup and inspect each failed item before
   taking any further destructive action.

Approval does not delete in the web request. The five-minute jobs Cron leases
items, rechecks that each message is still eligible, deletes D1 metadata, and
then removes the snapshotted R2 keys in chunks. Restored, newly starred, or
newly labeled messages are recorded as skipped. Once a run is `running`, it
cannot be cancelled; this prevents a misleading cancellation while R2 cleanup
is already in progress.

The archived behavior comparison and the final account/deployment evidence
gates are maintained in [`legacy-parity.md`](legacy-parity.md) and
[`release-readiness.md`](release-readiness.md).
