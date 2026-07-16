# ADR 0004: Idempotent MIME persistence

## Status

Accepted

## Context

Queue messages can be delivered more than once. R2 and D1 do not share a
transaction, and MIME parsing must not make the original message unavailable
when content is malformed. User-provided filenames also must not become object
keys.

## Decision

The jobs Worker consumes one message per Queue batch and performs these steps:

1. Validate the version 2 Queue contract and its immutable mailbox ID.
2. Match the staged R2 size and internal metadata to the contract. The same
   staging prefix retains a JSON copy of that contract for orphan recovery.
3. Parse MIME with bounded header and nesting limits while computing SHA-256
   from a second branch of the raw stream.
4. Detect redelivery by message ID and duplicate content by mailbox plus raw
   SHA-256.
5. Write deterministic canonical R2 objects for raw MIME, text, HTML, and
   ordinal attachment keys.
6. Insert the message and attachment records in one D1 batch.
7. Mark the D1 handoff stored and delete the staged raw/contract pair only
   after D1 confirms the message record.

Malformed MIME and attachment-limit violations retain the canonical raw object
as a quarantined message. Filenames are metadata only; attachment object keys
use zero-padded ordinals. Contract, staging, and mailbox mismatches are retried
until the configured dead-letter queue persists them in D1 for inspection.

## Consequences

- Exact Queue redelivery is safe, and equal raw content is stored once per
  mailbox.
- Raw MIME remains available when derived content cannot be extracted.
- A D1 failure can leave deterministic canonical R2 objects that a retry will
  overwrite; deleting them as compensation could race with another delivery.
- Operations still need reconciliation for orphaned staging and canonical
  objects.
