# ADR 0009: Server-derived outbound threading

## Status

Accepted

## Context

Reply and forward actions need to preserve a relationship with a stored
message. Browser-supplied `In-Reply-To` or `References` values would let a
caller forge thread metadata, cross mailbox boundaries, or exceed Email
Service header limits. The relationship is also useful operational metadata
that does not belong in the delivery retry record.

## Decision

Compose requests identify only a `composeMode` and, for replies or forwards, a
`sourceMessageId`. The database layer verifies that the source belongs to the
selected mailbox. It derives reply headers from the stored RFC `Message-ID`
and `References`; the browser cannot submit either header directly.

References are reduced to valid angle-bracket message IDs, deduplicated,
limited to the newest 100 entries, and trimmed to the Email Service 2,048-byte
custom-header limit. Replies persist and send both `In-Reply-To` and
`References`. Forwards keep source provenance but intentionally do not claim
to be an RFC reply.

`outbound_compositions` stores mode and nullable source provenance separately
from `messages` content and `outbound_deliveries` retry state. Existing
outbound rows are migrated as new compositions.

## Consequences

- A source message from another mailbox is indistinguishable from an invalid
  source at the compose boundary and is rejected before R2 writes.
- Thread headers used by the R2 compose snapshot, D1 row, and Email Service
  request come from one server-derived value.
- Deleting a source can clear provenance through `ON DELETE SET NULL` without
  deleting the outbound message.
- Subject prefixes and quoted body text remain editable presentation choices;
  they are not security inputs and do not determine RFC threading.
