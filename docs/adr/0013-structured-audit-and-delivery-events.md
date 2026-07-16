# ADR 0013: Structured audit and delivery events

## Status

Accepted

## Context

The archived Worker mixed operational diagnostics, delivery failures, and
administrator actions across console output and loosely structured tables.
The rebuilt service has separate Ingest, Jobs, and Web Workers, so a useful
incident trace must survive Worker boundaries and message deletion without
copying raw mail or body content into D1.

## Decision

`delivery_events` records a bounded direction, stage, outcome, category,
severity, mailbox/message reference, provider, error code, summary, and small
JSON details object. Ingest records routing/staging/Queue outcomes; Jobs records
canonical inbound completion, retries, rule failures, and outbound provider
outcomes. Event writes are best-effort and cannot reject or redeliver mail.

`audit_events` records authenticated API mutations plus raw and attachment
downloads. It stores the internal user ID when the Access issuer/subject is
linked, a bounded email snapshot, a redacted route, response status, Ray or
request ID, Cloudflare client IP, and user agent. It never stores request
bodies, message bodies, MIME headers, recipient lists, or attachment content.
Audit writes are likewise fail-safe and do not change the API result.

Global administration is an explicit `system_administrators` grant. Mailbox
ownership alone does not confer global access. Bootstrap grants are generated
only for manifest users with `systemAdmin: true`; omitting the flag does not
silently revoke an existing administrator.

Message trash transitions now store `deleted_at`. Restoring a message clears
that timestamp. Rule trash/archive actions and optimistic undo preserve the
same invariant so later retention decisions use the time of deletion rather
than message receipt or creation time.

## Consequences

- Operational searches can correlate a message ID across Workers without
  exposing mail content.
- Delivery and audit rows remain meaningful after hard deletion because their
  references are intentionally not cascading message foreign keys.
- Event table growth requires an explicit retention policy and reviewed purge;
  no Worker silently deletes logs in this phase.
- The first production manifest must name at least one intended system
  administrator before the administrative API/UI is useful.
