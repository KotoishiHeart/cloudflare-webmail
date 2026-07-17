# ADR 0010: R2-backed outbound attachments

## Status

Accepted

## Context

The archived application accepted up to eight attachments, with a 10 MiB
per-file and 20 MiB aggregate limit. Carrying provider-specific base64 JSON
through the browser, Queue, or D1 would increase memory use and couple durable
contracts to one provider.

A complete RFC 822 compose snapshot base64-encodes binary MIME parts. At the
legacy 20 MiB attachment limit that representation can exceed the 25 MiB D1
`raw_size` constraint even though the outbound content remains below its
provider safety limit.

## Decision

The browser sends `multipart/form-data` only when files are selected. A small
JSON `payload` part carries the ordinary compose fields and repeated
`attachments` parts carry raw files. The web Worker bounds the entire request
stream to 22 MiB before parsing, then enforces eight files, 10 MiB per file,
20 MiB total, safe filenames, and the archived executable/script denylist.

Each attachment is hashed with SHA-256 and stored as its own deterministic R2
object. D1 `attachments` rows are inserted in the same batch as the outbound
message and delivery. The R2 compose snapshot remains a complete MIME message;
when attachments exist it is gzip-compressed for storage and transparently
decompressed by the authorized raw-download endpoint.

The jobs Worker reloads every attachment from R2 and verifies both size and
SHA-256 before any external send. The provider-neutral boundary receives binary
`ArrayBuffer` content; only the SMTP2GO adapter base64-encodes it immediately
before creating the HTTPS request. Integrity failure is terminal and no
provider request is made.

## Consequences

- No attachment bytes or base64 strings cross the Queue or D1 boundary.
- R2 remains the binary source of truth; D1 provides normalized searchable
  metadata and integrity expectations.
- Outbound `raw_size` is the stored snapshot size when gzip is used, while
  individual attachment sizes remain exact and independently auditable.
- Inline/CID composition is intentionally excluded; received inline parts are
  still preserved by the inbound pipeline.
- Adapter contract tests verify the exact base64 payload without using a real
  key; a deployed canary must still prove provider acceptance and delivery.
