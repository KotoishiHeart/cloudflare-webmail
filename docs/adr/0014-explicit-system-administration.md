# ADR 0014: Explicit system administration boundary

Status: accepted

## Decision

System administration is independent from mailbox ownership. An authenticated
Cloudflare Access identity must resolve to an active `users` row and that user
must have an explicit `system_administrators` grant before any `/api/admin/*`
route is evaluated.

Administrative resources are split by responsibility: directory reads, user
operations, mailbox operations, event queries, request validation, and routing.
Normal mailbox APIs never infer system authority from an email allowlist or an
owner membership.

Destructive directory operations are soft state transitions. The current
administrator cannot disable or revoke itself, the last active administrator
cannot be revoked, an active user's final Access identity is retained, and a
mailbox retains a primary address and at least one owner. Every mutation is
captured by the structured API audit layer.

## Consequences

Initial administrator grants remain an explicit provisioning operation. Later
grants can be managed through the API without deployment configuration changes.
Directory deactivation is reversible and does not cascade into stored mail.
