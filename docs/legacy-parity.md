# Archived behavior parity boundary

This document is the completion boundary for rebuilding
`cloudflare-webmail-archived`. It compares user-visible and operational
behavior, not filenames or the archived all-in-one Worker structure.

Status meanings:

- **Rebuilt**: implemented in the separated Web, Ingest, Jobs, database, or
  operations layers.
- **Replaced**: the operational outcome is retained through a safer or more
  portable design rather than copying the archived implementation.
- **External**: Cloudflare account policy owns the behavior; this repository
  validates or documents it but does not mutate it automatically.
- **Excluded**: deliberately not carried forward because it weakens the new
  security, data, or deployment boundary.

## User and mail behavior

| Archived behavior | Rebuild status | Current implementation/evidence |
| --- | --- | --- |
| Cloudflare Access login with no application password | Rebuilt | The Web Worker validates the Access JWT issuer, audience, signature, expiry, and subject. D1 maps the exact issuer/subject to a user; email claims are display-only. |
| Multiple users, mailboxes, domains, and addresses | Rebuilt | Stable users and mailboxes have explicit viewer/operator/owner memberships. Each mailbox has one primary address and active/disabled aliases; addresses from any routed domain can be assigned. |
| Domain DNS, Email Routing, and forwarding policy management | External | The deployment manifest names sending/routing domains and preflight reads their state. Cloudflare Dashboard/API policy remains separately reviewed instead of being mutated from the mail application. |
| Mailbox, representative address, send-only, receive-only, and quarantine account kinds | Replaced | A primary address is the authorized receive/send identity, aliases receive into the same mailbox, and mailbox/address status can stop service. Forward-only and quarantine routing stay in Cloudflare Email Routing so they cannot bypass mailbox authorization. |
| Inbox, outbox, sent, starred, archive, trash, and all folders | Rebuilt | Mailbox-scoped D1 queries use `(received_at, id)` cursor pagination and never accept a mailbox identity from an unverified claim. |
| Detailed and quick search | Rebuilt | Subject, bounded body preview, participants, outbound Bcc, attachment names, labels, date, size, read/star, HTML/body state, and domain filters are supported. |
| FTS5 search index and rebuild command | Replaced | `message_search_documents` is a normal exportable D1 table maintained with each message. This avoids FTS virtual-table export/rebuild failure while preserving the archived bounded-search behavior. |
| Message detail, safe HTML, raw MIME, and attachment downloads | Rebuilt | Every read is authorized through mailbox membership. HTML is parser-sanitized, strips remote/active content, and is shown only in a restricted sandbox iframe. R2 sizes and SHA-256 values are checked where applicable. |
| Read/unread, star, archive, trash, restore, bulk selection, and undo | Rebuilt | Single and bounded atomic bulk PATCH operations are same-origin protected. The UI provides immediate undo without granting viewers mutation controls. |
| New mail, Bcc, reply, forward, and attachments | Rebuilt | Compose is persisted to D1/R2 before Queue publication. Reply headers and source provenance are derived server-side. Limits remain 8 files, 10 MiB each, and 20 MiB total. |
| SMTP2GO provider API | Replaced | Jobs sends through a Cloudflare Email Service binding. The primary mailbox address is the only permitted From identity; domain onboarding and SPF/DKIM/DMARC remain explicit account tasks. |
| Duplicate-send protection | Rebuilt | A caller idempotency key is unique per mailbox, the outbox is written before publish, and delivery uses a D1 lease with a bounded retry state machine. |
| Local compose drafts and keyboard shortcuts | Rebuilt | Text fields are bounded and stored in `localStorage` by mailbox/mode/source. Attachments are never persisted. `/` focuses search and `c` opens compose. |
| Offline PWA | Rebuilt | Only HTML/CSS/JS/icons are cached. APIs, bodies, raw mail, attachments, drafts, and automatic outbound retries remain network-only. |

## Automation, administration, and lifecycle

| Archived behavior | Rebuild status | Current implementation/evidence |
| --- | --- | --- |
| Labels and user display settings | Rebuilt | Labels are mailbox-scoped with composite foreign keys; preferences are keyed by the stable internal user ID. |
| Sender/recipient/subject/domain/attachment/size/keyword rules | Rebuilt | Rules support preview, frozen match runs, explicit apply, automatic inbound application, and optimistic undo for star/archive/trash/label actions. |
| Account, alias, membership, and administrator management | Rebuilt | A separate `/admin.html` PWA uses an explicit `system_administrators` grant. It manages users, identities, mailboxes, addresses, memberships, and administrator grants with last-admin/last-owner protections. |
| Delivery, rule, lifecycle, and security history | Rebuilt | Structured delivery and audit events are bounded, filterable, and mailbox-linked. Cron removes at most 500 delivery rows older than 90 days and 500 audit rows older than 365 days. |
| Content-wide administrator cross-search | Excluded | Administrators get structured event and directory views; mail content search remains inside an authorized mailbox. A global content endpoint would unnecessarily bypass the membership boundary. |
| Lifecycle preview, permanent delete, and restore safety | Rebuilt | Retention is disabled by default. Preview freezes candidates; approval requires verified-backup evidence; Jobs rechecks eligibility, deletes D1 metadata, then removes snapshotted R2 keys resumably. |
| Attachment/blob deduplication apply | Replaced | Canonical R2 keys belong to one message, eliminating shared-object deletion ambiguity. Incremental D1-to-R2 and R2-to-D1 audits report missing or unreferenced objects; they never delete on discovery. |
| Read-only/send-disabled/import-disabled/safe-stop application modes | Replaced | Mailbox/user status, Access policy, Email Routing target, and separated Worker deployment gates provide narrower controls. Cutover closes archived Web mutations through Access and never depends on a mutable global D1 mode. |
| D1 Free daily-limit handling | Rebuilt | Queue consumers distinguish a daily D1 quota error from storage/permanent errors and delay retry until just after 00:00 UTC, capped at the platform's 24-hour message-delay limit. Other transient failures use bounded exponential backoff and DLQ persistence. |

## Migration, backup, and release operations

| Archived behavior | Rebuild status | Current implementation/evidence |
| --- | --- | --- |
| Maildir and raw EML import | Rebuilt | Local prepare produces a hash-bound, deduplicated D1/R2 stage. Verify precedes explicit local or remote apply, and retries resume from state. |
| cPanel/SSH one-command migration | Replaced | Operators first acquire Maildir or an archived D1/R2 snapshot outside the application. The repository then performs deterministic offline conversion; SSH credentials and remote-server mutation are outside its trust boundary. |
| Archived D1/R2 migration | Rebuilt | Safe SQL is parsed into an isolated SQLite adapter, account mapping is explicit, raw snapshots are resumable, MIME is rebuilt, bulk R2 comparison precedes D1, and final D1/R2 audit is read-only. |
| Safe D1 backup, R2 manifest, verification, and restore planning | Rebuilt | Portable backups contain the D1 export plus every canonical referenced object with size/SHA-256. Restore is resumable and only targets explicitly new, empty D1/R2 resources. |
| Admin mail export manifest | Replaced | The operator backup/migration manifests provide an offline-verifiable export without adding a Web endpoint that exposes cross-mailbox object keys and content. |
| CI, staging, production approval, and post-deploy checks | Rebuilt | CI runs generated binding checks, TypeScript, Node tests, Worker integration tests, and three dry builds. A protected workflow performs read-only production preflight; mutation stays on a secured operator host with backup evidence. |
| Automatic application/resource/token provisioning | Excluded | The new CLI creates reviewed plans but never creates Access service tokens, R2 credentials, or secret `.generated` files. D1/R2/Queue/Access/Email policy creation requires an authenticated operator. |
| Public inbound simulation and direct MX SMTP probing | Excluded | Canary verification uses real Access identities and real Email Routing/Email Service. There is no production test endpoint that can inject mail around the Ingest boundary. |
| Destructive reset/destroy helpers | Excluded | Permanent deletion and restore require preview, backup, explicit approval, audit, and post-check. There is no convenience command that wipes active mail resources. |
| Worker rollback and data rollback | Rebuilt | Upgrade deploy records the exact 100%-active version for Web, Ingest, and Jobs. Explicit rollback restores those versions only; D1/R2 recovery always uses verified new resources. |
| Automatic reverse import after cutover | Excluded | Mail accepted after the routing boundary is preserved in the rebuild and must be reconciled explicitly. No automated tool silently writes it back into archived storage. |

The archived project also states that IMAP polling, Hono, server-side drafts,
and offline mail-body caching were never implemented. They are therefore not
parity requirements and remain outside this rebuild.

## Reconstructed file responsibilities

The rebuild intentionally does not reproduce the archived multi-thousand-line
Worker entrypoint:

- `apps/web/src`: Access boundary, bounded API routing, same-origin mutation,
  R2 downloads, safe HTML, compose, and administration controllers.
- `apps/web/public`: static mailbox/admin shells and small UI controllers; the
  Service Worker owns shell caching only.
- `apps/ingest/src`: Email Routing validation, D1 address resolution, durable
  R2 staging, handoff ledger, and Queue publication.
- `apps/jobs/src`: MIME processing, inbound/outbound consumers, DLQ/recovery,
  reconciliation, retention, and scheduled maintenance.
- `packages/contracts/src`: versioned Queue payloads and strict parsers.
- `packages/database/src`: prepared queries, authorization, mailbox records,
  state transitions, audit, and retention primitives.
- `migrations`: forward-only shared D1 history.
- `tools/lib`: offline plans, migration, backup/restore, deploy, rollback,
  postflight, and cutover evidence generation.
- `tests` and `tools/tests`: Worker integration and Node/offline-operation
  verification.

Production TypeScript/JavaScript modules are limited to 250 physical lines.
`tools/tests/architecture.test.mjs` enforces that boundary, the credential
ignore policy, ordered migration filenames, empty-database migration success,
the exact 30-table schema, and foreign-key integrity. Generated bundles,
binding declarations, SQL migrations, tests, and documentation are excluded
from the module line budget.
