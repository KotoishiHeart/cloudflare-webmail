# ADR 0003: Durable inbound handoff

## Status

Accepted

## Context

Email Routing provides the original message as a single-use stream. Queue
messages have a bounded payload and can be delivered more than once, so the
raw MIME message cannot safely be carried as the Queue body or parsed during
the SMTP-facing request.

R2 persistence and Queue publication are separate operations. There is no
transaction spanning both services, and a Queue exception does not prove that
the message was not accepted by the service.

## Decision

The ingest Worker performs the handoff in this order:

1. Resolve an active primary address or alias in D1.
2. Validate the declared Email Routing size before consuming the stream.
3. Stream the raw message through `FixedLengthStream` into an immutable,
   message-specific R2 key.
4. Verify the versioned Queue contract locally.
5. Publish only the R2 key and bounded routing metadata to Queue.

R2 object metadata contains internal identifiers and sizes, not sender,
recipient, subject, or message content. The Queue message uses the addressed
alias in its envelope and the mailbox primary address as its account identity.

Unknown recipients and failed handoffs are rejected. If Queue publication
throws after R2 succeeds, the R2 object is retained for recovery because the
publication result may be ambiguous.

## Consequences

- MIME parsing is removed from the SMTP-facing path.
- The Queue consumer can retry against a stable R2 object.
- Length mismatches fail before Queue publication.
- Duplicate delivery remains possible and must be made idempotent in Stage 4.
- Orphaned staging objects require reconciliation and lifecycle cleanup in the
  operational stage.
