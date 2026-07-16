# ADR 0001: Separate Worker entrypoints by runtime responsibility

## Status

Accepted

## Context

The archived Worker combines HTTP routing, Email Routing, Queue processing,
mailbox queries, administration, HTML rendering, and delivery orchestration in
one entrypoint. This made the entrypoint responsible for changes with unrelated
security, resource, and deployment risks.

## Decision

Maintain one repository with three Worker applications:

- `web` owns HTTP authentication, APIs, and user-facing assets.
- `ingest` performs only recipient resolution, raw MIME staging, and Queue send.
- `jobs` performs retryable MIME processing and other background operations.

All data crossing an asynchronous boundary uses a versioned contract from
`packages/contracts`. Synchronous cross-Worker calls, if later required, must
use Service Bindings rather than public HTTP endpoints.

## Consequences

- Each Worker can be deployed and rolled back independently.
- Ingest remains small enough to minimize Email Routing CPU and memory risk.
- Queue payload changes require explicit schema evolution.
- Shared bindings and environments require separate Wrangler configurations.
