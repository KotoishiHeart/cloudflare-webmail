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

## Status and failed outbound delivery

The status command returns aggregate counts and no message content or email
addresses:

```bash
npm run ops -- status --local
npm run ops -- status --remote \
  --config ops/deploy-production/configs/web.wrangler.json
```

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
