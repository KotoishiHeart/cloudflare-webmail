# ADR 0005: Access-protected web boundary

## Status

Accepted

## Context

Cloudflare Access blocks unauthenticated traffic at the edge, but a Worker
origin must not trust the presence of identity headers alone. Static assets,
JSON metadata, R2 message objects, and message mutations also have different
browser security and caching requirements.

## Decision

The web Worker uses the Access application token from
`Cf-Access-Jwt-Assertion` and verifies its RS256 signature, issuer, audience,
expiry, `type=app`, subject, and email with the team's rotating JWKS. The
resolver caches only public key configuration in the isolate; tokens and
identities remain request scoped.

Application authorization uses the verified issuer and subject to join active
D1 users, memberships, and mailboxes. The email claim is displayed but is not
an authorization key. Service-token identities are not interactive webmail
users.

Workers Static Assets runs the Worker first for every asset request. API
metadata is `no-store`; body, raw MIME, and attachments stream from R2 only
after the D1 authorization join. Internal object keys are never returned by the
API. Attachment responses force download, while HTML message bodies are served
as `text/plain` source. Message mutations require operator capability,
same-origin JSON, and a bounded request body.

## Consequences

- Direct Worker routes fail closed even if an Access application is
  accidentally bypassed.
- A verified Access user without an explicit D1 identity link sees no mailbox.
- Static application code can be cached normally, while mailbox data cannot.
- Rich sanitized HTML rendering and composing remain separate later features.
