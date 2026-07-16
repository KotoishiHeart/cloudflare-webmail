# ADR 0006: Queue-backed outbound delivery

## Status

Accepted

## Context

Email sending is an external side effect and must not run inside the browser's
HTTP request. Cloudflare Queues provides at-least-once delivery, while Email
Service generates the wire `Message-ID` and does not expose an application
idempotency key. A provider acceptance followed by a Worker or D1 failure can
therefore produce an ambiguous outcome.

## Decision

An operator submits bounded text compose data with a required UUID
`Idempotency-Key`. The web Worker validates a maximum of 50 unique recipients,
stores text, generated safe HTML, and a MIME compose snapshot in R2, and creates
the message, normalized recipient rows, and delivery record in one D1 batch.
The Queue contract contains only the message and mailbox IDs.

The jobs Worker claims one delivery at a time with a five-minute D1 lease,
reloads all content from D1/R2, and sends both text and HTML through the native
Email Service binding. Provider validation and sender-domain errors become a
terminal failed record. Rate limits, daily limits, delivery failures, internal
errors, and local storage faults use delayed Queue retry. Ten D1 claims is the
application retry ceiling.

A five-minute scheduled handler republishes stale queued records and expired
leases. D1 status transitions are idempotent, so ordinary Queue redelivery does
not resend completed or terminally failed messages. The browser can safely
retry an ambiguous compose request with the same idempotency key.

## Consequences

- HTTP latency and browser disconnects do not control provider delivery.
- The R2 `raw.eml` is explicitly a compose snapshot, not the exact
  provider-generated wire message.
- A crash after Email Service accepts a message but before D1 records
  `messageId` can still result in a duplicate send. This residual risk is logged
  and documented because the provider API has no caller idempotency key.
- BCC recipients are normalized in the delivery table and omitted from the
  archived MIME headers and regular message summary.
- Attachments use a separate bounded multipart upload and R2 integrity flow;
  provider-specific base64 JSON is never placed on the Queue.
