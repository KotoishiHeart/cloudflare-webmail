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
message and its versioned Queue contract to R2, records a D1 handoff ledger,
and only then publishes the Queue message. Unknown recipients, invalid sizes,
and failed durable handoffs are rejected. The jobs Worker
validates staged objects, parses MIME, stores canonical message objects in R2,
and records searchable message metadata in D1. Queue redelivery is idempotent by
message ID and raw-message SHA-256.

Outbound compose requests are first persisted as D1/R2 outbox records and then
sent by the jobs Worker through the Cloudflare Email Service binding. The
outbound Queue is processed one message at a time, with D1 leases, delayed
retry, a persisted dead-letter workflow, and scheduled recovery scans. The current compose
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

The committed development configurations declare the `DB` binding without a
production `database_id`. Create the `cf-webmail` D1 database and put its ID in
an ignored deployment manifest; the deployment tool generates all three
production configurations from that single value. Local migrations and tests
do not require a Cloudflare account.

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
a production Email Routing rule. The primary consumers retry each message up
to five times and then send it to a DLQ consumer. That consumer persists the
payload in D1 before acknowledging it; an operator can then request an
asynchronous, contract-validated retry.

Before deploying the web Worker, create a Cloudflare Access self-hosted
application for its public hostname with an explicit Allow policy. Put the
following values in the ignored deployment manifest. The committed development
configuration deliberately remains fail closed:

- `ACCESS_TEAM_DOMAIN`: the `https://<team>.cloudflareaccess.com` issuer.
- `ACCESS_AUD`: the Access application's Audience tag.

The corresponding Access issuer and subject must also be explicitly linked in
the D1 `access_identities` table. Email claims are display metadata and are not
used as the application authorization key. The interactive UI does not accept
Access service tokens or provide a local authentication bypass.

The ingest Worker deliberately retains staged R2 objects when Queue production
throws. Queue outcomes can be ambiguous, and deleting them could make an
already-enqueued job unrecoverable. The D1 handoff ledger re-enqueues stale
`staged` and `queue_failed` records idempotently. A later operational stage will
also reconcile R2 objects created before a handoff row could be written.

`worker-configuration.d.ts` files are generated from each Worker configuration
with Wrangler and are checked in CI through `npm run types:check`.

Operational D1 changes use the review-first CLI described in
[`docs/operations.md`](docs/operations.md). It generates stable provisioning
SQL from a versioned manifest, requires an explicit local/remote target and
confirmation for mutations, and provides aggregate status, single-message
outbound retry, and persisted DLQ retry commands.

Maildir and archived raw-object migrations use the resumable stage workflow in
[`docs/migration.md`](docs/migration.md). Preparation and hash verification are
fully local; an explicit `apply --local|--remote --yes` uploads R2 objects
before applying chunked D1 inserts.

The archived D1 safe-backup adapter and account-to-mailbox mapping workflow are
documented separately in
[`docs/legacy-migration.md`](docs/legacy-migration.md). It first isolates the
old SQL in a local compatibility database and records account-level counts and
integrity results before any R2 object is copied.

Portable D1/R2 backups and empty-target restores are documented in
[`docs/backup-and-restore.md`](docs/backup-and-restore.md). Each completed
bundle has an offline-verifiable manifest with hashes for the D1 export and
every referenced R2 object.

Production configuration and Worker upload use the review-first staged process
in [`docs/deployment.md`](docs/deployment.md). A non-secret manifest generates
hash-bound configs for the exact Git commit; remote preflight remains separate
from the confirmation-required migration and deploy step.

## Implementation stages

1. Completed: Worker entrypoints, versioned contracts, generated binding types,
   and tests.
2. Completed: D1 baseline schema and mailbox authorization model.
3. Completed: Email Routing to R2 staging and Queue production.
4. Completed: Queue MIME parsing and D1/R2 persistence.
5. Completed: Access-protected Web API and Static Assets UI.
6. Completed: Queue-backed outbound delivery, review-first operations,
   resumable mail migration, and portable D1/R2 backup and restore tooling.
7. Completed: manifest-driven production configuration, remote preflight, and
   dependency-ordered Worker deployment tooling.
8. Completed: archived D1/R2 compatibility migration with explicit account
   mapping, resumable raw snapshots, parallel bulk transfer, full R2 content
   comparison, and target D1 count/metadata verification.
