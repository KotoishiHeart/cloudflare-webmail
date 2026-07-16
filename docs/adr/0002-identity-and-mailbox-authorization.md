# ADR 0002: Identity and mailbox authorization

## Status

Accepted for Stage 2.

## Decision

Store application users, Cloudflare Access identities, mailboxes, routed
addresses, and mailbox memberships as separate D1 records.

An authenticated identity is keyed by the verified Access token's issuer and
subject. The email claim is retained for display and audit purposes, but it is
not the authorization key. Identity linking is explicit and fails closed.

Mailbox roles are hierarchical:

- `viewer` grants read access.
- `operator` adds message mutation and sending operations.
- `owner` adds mailbox and membership administration.

Every mailbox is created atomically with one active primary address and an
owner membership. Additional routed addresses are aliases. Disabled users,
mailboxes, or addresses are never considered active authorization targets.

## Consequences

- Email Routing can resolve recipients without depending on a web session.
- The web API and background workers can reuse one authorization package.
- Access email changes do not silently transfer permissions to a new identity.
- Initial users and identity links require an explicit provisioning workflow.
