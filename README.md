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

The ingest Worker rejects mail until the durable R2 staging implementation is
added. The jobs Worker is not registered as a Queue consumer yet. These safe
defaults prevent a partial deployment from silently accepting and losing mail.

## Development

```bash
npm install
npm run types
npm run check
```

`worker-configuration.d.ts` files are generated from each Worker configuration
with Wrangler and are checked in CI through `npm run types:check`.

## Implementation stages

1. Worker entrypoints, versioned contracts, generated binding types, and tests.
2. D1 baseline schema and mailbox authorization model.
3. Email Routing to R2 staging and Queue production.
4. Queue MIME parsing and D1/R2 persistence.
5. Access-protected Web API and Static Assets UI.
6. Outbox delivery, operational CLI, migration, and backup tooling.
