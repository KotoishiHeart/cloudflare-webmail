# ADR 0015: Previewed and resumable retention deletion

Status: accepted

## Decision

Permanent deletion is never executed in a web request. A system administrator
enables a mailbox policy, freezes at most 200 eligible trash messages into a
preview, creates and verifies an external D1/R2 backup, and explicitly approves
that exact preview with the backup manifest reference, SHA-256, and creation
time. The scheduled jobs Worker then processes small leased work units.

Eligibility is checked again immediately before deletion. Restored, newly
starred, or newly labeled messages are skipped according to the policy snapshot.
D1 metadata is deleted transactionally with the durable item state before R2
objects are removed. Object keys remain in the retention item and are deleted
in bounded chunks, so a Worker interruption can resume without exposing a D1
message whose content has already disappeared. R2 deletion is idempotent.

Run and item rows deliberately retain message identifiers and bounded metadata
after the message row is removed. Failed work has a bounded retry count and is
visible in delivery events and the administration API.

## Consequences

Retention is disabled by default. Approval attests that an external backup was
verified; the Worker cannot itself access a local backup directory. The backup
must be newer than the preview so it contains every frozen candidate.

At most 20 objects are removed per work unit and ten work units are attempted
per Cron invocation. Large messages and runs therefore finish over multiple
invocations without exceeding normal Worker execution limits.
