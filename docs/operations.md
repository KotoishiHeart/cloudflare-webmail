# Operations runbook

The repository does not create or deploy remote Cloudflare resources by
default. Run every mutating command from the repository root, review generated
SQL first, and select `--local` or `--remote` explicitly.

## One-time Cloudflare resources

Create the resources declared by the committed Worker configurations:

```bash
npx wrangler d1 create cf-webmail
npx wrangler r2 bucket create cf-webmail-raw
npx wrangler queues create cf-webmail-inbound
npx wrangler queues create cf-webmail-inbound-dlq
npx wrangler queues create cf-webmail-outbound
npx wrangler queues create cf-webmail-outbound-dlq
```

Put the returned D1 `database_id`, Cloudflare account ID, and resource names in
an ignored deployment manifest as described in [`deployment.md`](deployment.md).
The deployment tool generates all three production configurations, avoiding
independent binding edits. Then onboard each sender domain in **Compute > Email
Service > Email Sending** and confirm SPF/DKIM before enabling outbound
delivery. Configure Cloudflare Access for the Web hostname and put its team
domain and audience tag in the same deployment manifest.

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
checking Email Service logs, because a second delivery can be visible to the
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
