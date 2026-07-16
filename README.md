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
recipients, invalid sizes, and failed handoffs are rejected. The jobs Worker is
not registered as a Queue consumer until Stage 4, so do not enable a production
Email Routing rule before that stage is deployed.

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

Stage 3 also expects these account resources before remote deployment:

```bash
npx wrangler r2 bucket create cf-webmail-raw
npx wrangler queues create cf-webmail-inbound
```

The ingest Worker deliberately retains a staged R2 object when Queue production
throws. Queue outcomes can be ambiguous, and deleting the object could make an
already-enqueued job unrecoverable. A later operational stage will reconcile
and expire orphaned staging objects.

`worker-configuration.d.ts` files are generated from each Worker configuration
with Wrangler and are checked in CI through `npm run types:check`.

## Implementation stages

1. Worker entrypoints, versioned contracts, generated binding types, and tests.
2. D1 baseline schema and mailbox authorization model.
3. Email Routing to R2 staging and Queue production.
4. Queue MIME parsing and D1/R2 persistence.
5. Access-protected Web API and Static Assets UI.
6. Outbox delivery, operational CLI, migration, and backup tooling.
