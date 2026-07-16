# Cloudflare Webmail

This repository is the staged rebuild of `cloudflare-webmail-archived`.
The archived implementation remains the behavior and migration reference while
the new implementation is introduced in independently verifiable stages.

## Architecture

The repository starts with three deliberately small Worker entrypoints:

- `apps/web`: authenticated HTTP application and static asset gateway.
- `apps/ingest`: Cloudflare Email Routing entrypoint.
- `apps/jobs`: Queue consumers for MIME processing and background work.
- `packages/contracts`: versioned data crossing Worker and Queue boundaries.
- `packages/database`: prepared D1 queries and mailbox authorization rules.
- `migrations`: the forward-only D1 schema history shared by all Workers.

The ingest Worker resolves active D1 mailbox addresses, streams the original
message to R2, and only then publishes a versioned Queue message. Unknown
recipients, invalid sizes, and failed handoffs are rejected. The jobs Worker
validates staged objects, parses MIME, stores canonical message objects in R2,
and records searchable message metadata in D1. Queue redelivery is idempotent by
message ID and raw-message SHA-256.

Outbound compose requests are first persisted as D1/R2 outbox records and then
sent by the jobs Worker through the Cloudflare Email Service binding. The
outbound Queue is processed one message at a time, with D1 leases, delayed
retry, a dead-letter queue, and a scheduled recovery scan. The current compose
surface sends text plus generated safe HTML and intentionally does not accept
attachments yet.

The web Worker independently verifies the Cloudflare Access application JWT,
maps its issuer and subject to D1 memberships, exposes a bounded JSON and
streaming API, and serves the browser application through Workers Static
Assets. HTML mail is shown as source text in this stage instead of being
inserted into the page DOM.

## Development

```bash
npm install
npm run types
npm run db:migrate:local
npm run check
```

The committed Worker configuration declares the `DB` binding without a
production `database_id`. Create the `cf-webmail` D1 database and add the ID to
all three Worker configurations before a remote migration or deployment. Local
migrations and tests do not require a Cloudflare account.

Inbound and outbound processing expect these account resources before remote
deployment:

```bash
npx wrangler r2 bucket create cf-webmail-raw
npx wrangler queues create cf-webmail-inbound
npx wrangler queues create cf-webmail-inbound-dlq
npx wrangler queues create cf-webmail-outbound
npx wrangler queues create cf-webmail-outbound-dlq
```

Onboard every sender domain in **Compute > Email Service > Email Sending** and
confirm its SPF/DKIM records before deploying the jobs Worker. The committed
`EMAIL` binding has no static destination restriction because authorized D1
mailboxes are dynamic; the application still restricts `From` to each active
mailbox's primary address. Keep DMARC policy and monitoring under operational
control.

Apply all D1 migrations and deploy the ingest and jobs Workers before enabling
a production Email Routing rule. The jobs consumer retries each message up to
five times and then sends it to the dead-letter queue for inspection.

Before deploying the web Worker, create a Cloudflare Access self-hosted
application for its public hostname with an explicit Allow policy. Then replace
the fail-closed values in `apps/web/wrangler.jsonc`:

- `ACCESS_TEAM_DOMAIN`: the `https://<team>.cloudflareaccess.com` issuer.
- `ACCESS_AUD`: the Access application's Audience tag.

The corresponding Access issuer and subject must also be explicitly linked in
the D1 `access_identities` table. Email claims are display metadata and are not
used as the application authorization key. The interactive UI does not accept
Access service tokens or provide a local authentication bypass.

The ingest Worker deliberately retains a staged R2 object when Queue production
throws. Queue outcomes can be ambiguous, and deleting the object could make an
already-enqueued job unrecoverable. A later operational stage will reconcile
and expire orphaned staging objects.

`worker-configuration.d.ts` files are generated from each Worker configuration
with Wrangler and are checked in CI through `npm run types:check`.

Operational D1 changes use the review-first CLI described in
[`docs/operations.md`](docs/operations.md). It generates stable provisioning
SQL from a versioned manifest, requires an explicit local/remote target and
confirmation for mutations, and provides aggregate status and single-message
outbound retry commands.

## Implementation stages

1. Completed: Worker entrypoints, versioned contracts, generated binding types,
   and tests.
2. Completed: D1 baseline schema and mailbox authorization model.
3. Completed: Email Routing to R2 staging and Queue production.
4. Completed: Queue MIME parsing and D1/R2 persistence.
5. Completed: Access-protected Web API and Static Assets UI.
6. In progress: completed Queue-backed outbox delivery; operational CLI,
   migration, and backup tooling follow as separate commits.
