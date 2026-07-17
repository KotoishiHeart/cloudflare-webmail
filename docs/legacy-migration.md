# Archived deployment migration

The archived application stores its protected data in two separate places:
the D1 safe logical backup contains metadata and R2 keys, while the R2 bucket
contains raw MIME, derived bodies, and attachment objects. The SQL file alone
is not a complete mail backup.

Migration is split into reviewable phases. The first phase converts the old
logical SQL into an isolated local SQLite database. It accepts only the
`DELETE`, `INSERT`, transaction, and `foreign_keys` statements emitted by the
archived safe-backup tool; other SQL is rejected before it can become a
migration source.

```bash
npm run migrate:legacy -- import-sql \
  --sql /srv/legacy/cf-webmail-starter-db-safe.sql \
  --database ops/legacy.sqlite

npm run migrate:legacy -- inventory \
  --database ops/legacy.sqlite \
  --output ops/legacy-inventory.json \
  --mapping-template ops/legacy-mapping.json
```

The inventory records source hashes, global counts, account-level message and
flag counts, attachment counts, raw bytes, R2 reference counts, labels,
message-label assignments, rules, user preferences, and relational-integrity
failures. Exit status `2` means the inventory was written but at least one
integrity count is nonzero. The command prints only aggregate counts; addresses
remain in the owner-only inventory and mapping files instead of terminal or CI
logs.

Review the generated mapping. Every account containing messages must either
map to one unique target mailbox or have an explicit exclusion with a reason.
The generated target UUIDs are deterministic, but the corresponding mailboxes
must be included in the reviewed provisioning manifest before mail is applied.
Every mapped mailbox must have an owner. A user whose archived
`user_pref:<email>` setting is to be restored must be provisioned with that
same normalized user email and must be a member of its archived default
mailbox.

```bash
npm run migrate:legacy -- validate-mapping \
  --database ops/legacy.sqlite \
  --mapping ops/legacy-mapping.json
```

## Generate the rebuilt directory

Generate a valid current provisioning manifest instead of transcribing the
archived account catalog by hand. The owner UUID must remain stable, and the
issuer and subject must be copied from the intended Cloudflare Access identity,
not inferred from an email claim.

```bash
npm run migrate:legacy -- provision-template \
  --database ops/legacy.sqlite \
  --mapping ops/legacy-mapping.json \
  --owner-user-id 019c6f3c-6260-7000-8000-000000000001 \
  --owner-email owner@example.com \
  --owner-display-name "Migration owner" \
  --access-issuer https://team.cloudflareaccess.com \
  --access-subject ACCESS_IDENTITY_SUBJECT \
  --system-admin \
  --output ops/provision.legacy.json \
  --report ops/provision.legacy-review.json
```

The manifest initially assigns one explicitly identified owner to every mapped
mailbox. Edit and revalidate it if ownership differs. Active local alias or
representative rows with exactly one mapped local destination are included as
mailbox aliases. If the archived global `default_from` resolves to a mapped
account, it becomes the generated owner's authorized `defaultMailboxId`. The
separate review file preserves that resolution, account receive/send/kind
flags, domains, external or multi-target aliases, and archived membership
suggestions. Resolve every review item before applying the SQL: forwarding,
quarantine, log-only, DNS, and domain routing are external Cloudflare policy,
and a membership may be granted only after its exact Access issuer/subject has
been provisioned. Never treat an archived access email as an authorization key.

The generated SQL must be applied before the converted mail stage. Every stage
now starts with a prerequisite guard for the mapped mailbox ID, mapped primary
address, and at least one owner; a missing or conflicting directory entry stops
the D1 chunk before configuration or message rows are inserted.

After creating the non-secret deployment manifest, bind all of these local
decisions into one verification artifact:

```bash
npm run migrate:legacy -- verify-provisioning \
  --database ops/legacy.sqlite \
  --mapping ops/legacy-mapping.json \
  --manifest ops/provision.legacy.json \
  --review ops/provision.legacy-review.json \
  --deployment ops/deployment.production.json \
  --output ops/evidence/legacy-provisioning-verification.json
```

`ready: true` proves that every mapped UUID/address and generated local alias
is present, every mapped owner and system administrator has an identity for the
deployment's exact Access issuer, every active archived membership suggestion
has the reviewed role, the archived default From is assigned to an authorized
user, and both Email Routing and the declared SMTP2GO sender domains cover every
mapped domain, and the source/mapping/review files still agree. It also records
SHA-256 digests for the exact provisioning, review, and deployment artifacts.

The verifier deliberately blocks nonstandard archived account policies and
external/forward/quarantine/log-only aliases. Those require separately
verifiable Cloudflare routing evidence; editing a JSON review note cannot make
them pass. Inactive or excluded old membership suggestions are counted but are
not granted. Do not plan or apply provisioning until this verifier succeeds.

```bash
npm run ops -- plan \
  --manifest ops/provision.legacy.json \
  --output ops/provision.legacy.sql
```

## Snapshot archived raw MIME

The old D1 SQL contains R2 references but no object bodies. Copy only the raw
MIME objects into a resumable local snapshot. A restored object directory may
be used without Cloudflare access:

```bash
npm run migrate:legacy -- fetch \
  --database ops/legacy.sqlite \
  --mapping ops/legacy-mapping.json \
  --snapshot ops/legacy-raw-snapshot \
  --object-root /srv/legacy-r2
```

For a production-sized archive, use one read-only rclone bulk copy. Configure
a named S3 remote for the archived R2 bucket outside this repository, using a
credential that cannot write or delete objects:

```bash
npm run migrate:legacy -- bulk-fetch \
  --database ops/legacy.sqlite \
  --mapping ops/legacy-mapping.json \
  --snapshot ops/legacy-raw-snapshot \
  --rclone-source legacy-r2:cf-webmail-starter-mail-objects \
  --rclone-config /secure/legacy-rclone.conf \
  --transfers 16 --checkers 32 --concurrency 8
```

Bulk fetch freezes the complete mapped raw-key list and its SHA-256 inside the
snapshot, passes only unfinished keys to a single `rclone copy`, and never uses
delete or move against the source. Each download is then decompressed and
checked against the old D1 raw size and SHA-256 before entering the hashed
snapshot. Verified keys are skipped on resume, the transient key-shaped copy is
removed locally after processing, and changing the named source or rclone
configuration is rejected from the start of the first transfer. If rclone is
interrupted, the owner-only transient copy is retained so the same command can
skip files already present and resume. This avoids launching one Wrangler
process for each of tens of thousands of archived messages. The isolated
SQLite database, JSON migration artifacts, snapshot database, source-key list,
and verified MIME objects are created with owner-only permissions; the snapshot
directories are not traversable by other local users.

The per-object Wrangler path remains useful for a small rehearsal or diagnostic.
Select its local/remote target explicitly; it also only reads the source bucket:

```bash
npm run migrate:legacy -- fetch \
  --database ops/legacy.sqlite \
  --mapping ops/legacy-mapping.json \
  --snapshot ops/legacy-raw-snapshot \
  --bucket OLD_BUCKET --remote --config /srv/legacy/wrangler.toml \
  --concurrency 4
```

Each object is written to a hashed local filename and checked against the old
D1 `raw_sha256` and uncompressed size before it becomes `ready`. Missing and
invalid objects remain in the snapshot database and are retried on the next
`fetch`; changing the source database, mapping, bucket, or object directory is
rejected during a resume.

```bash
npm run migrate:legacy -- verify-snapshot \
  --database ops/legacy.sqlite \
  --mapping ops/legacy-mapping.json \
  --snapshot ops/legacy-raw-snapshot
```

## Build the current-format stage

Preparation reads only the isolated database and verified raw snapshot. It
preserves old flags, direction, received/created timestamps, Message-ID and
thread headers, while rebuilding body and attachment objects from raw MIME.
Malformed archived Date values that exceed the current 256-character message
limit are replaced by the Date parsed from verified raw MIME; the bounded
original value remains in migration provenance for audit.
The generated stage directories and every MIME, SQL, manifest, failure, and
apply-state file use owner-only permissions because they contain mail content
or identifying metadata. `prepare` and `verify-stage` print aggregate counts
only; account mappings remain in the protected manifest rather than terminal
or CI logs.
It also converts labels, message-label assignments, active rule definitions,
and per-user page density/default-mailbox preferences. Archived labels and
rules were global, so each is deterministically copied into every mapped
mailbox and assigned to that mailbox's owner. Page sizes above the rebuilt
50-message request bound are reduced to 50. The old record ID, account, Bcc,
compose/send metadata, deletion time, old R2 keys, and every configuration
source-to-target mapping are retained in dedicated migration provenance
tables.

Historical preview/apply/undo rule runs are not reactivated: their frozen
before/after format belongs to the archived global rule engine. Keep the
isolated SQL database as immutable history; the rebuilt engine starts new
mailbox-scoped run history from the migrated definitions.

```bash
npm run migrate:legacy -- prepare \
  --database ops/legacy.sqlite \
  --mapping ops/legacy-mapping.json \
  --snapshot ops/legacy-raw-snapshot \
  --stage ops/legacy-stage

npm run migrate:legacy -- verify-stage --stage ops/legacy-stage
```

Before remote apply on Workers Free, materialize the exact current schema in a
local SQLite database and record its final size and lower-bound row count:

```bash
npm run migrate:legacy -- capacity-rehearsal \
  --stage ops/legacy-stage \
  --database ops/legacy-capacity.sqlite \
  --provisioning ops/provision.legacy.json \
  --output ops/evidence/legacy-capacity.json
```

The evidence binds the stage digest to the resulting SQLite page count, base
table rows, R2 bytes, and R2 object count. It compares them with the dated
Workers Free limits. Index maintenance adds more D1 rows written, so
`minimumBaseRowWriteDays` is a lower bound rather than permission to schedule
that many exact days. A database above the per-database limit blocks the
single-D1 design even when total account storage is still available. Supplying
the reviewed provisioning manifest also exercises archived user-preference
prerequisites; omit it only when the stage contains no user preferences and a
synthetic owner is sufficient for a preliminary estimate.

## Free-plan baseline and final delta

Do not wait for the production freeze to apply the full archive on Workers
Free. D1 counts Wrangler imports and index maintenance against the daily rows
written limit, so the baseline can require several quota windows. Apply the
complete verified baseline while the archived Worker remains the production
Email Routing target and the rebuilt Web application remains closed to normal
users. `bulk-apply` records the next SQL file and safely resumes after the
daily quota resets; a failed file is idempotent and remains the next file.

At the final boundary, import a new archived safe backup under new paths. Its
source hash differs by design, so bind the reviewed mailbox topology to the
new backup without manually editing the hash:

```bash
npm run migrate:legacy -- import-sql \
  --sql /srv/legacy/cf-webmail-final-safe.sql \
  --database ops/legacy-final.sqlite

npm run migrate:legacy -- refresh-mapping \
  --baseline-database ops/legacy.sqlite \
  --database ops/legacy-final.sqlite \
  --mapping ops/legacy-mapping.json \
  --output ops/legacy-final-mapping.json
```

`refresh-mapping` preserves every target mailbox and exclusion, validates the
old mapping against the baseline, and then validates the same topology against
the final inventory. A new or removed account that makes the topology
ambiguous is a review blocker, not an automatically assigned mailbox.

Seed the final raw snapshot from the verified baseline. Matching old R2 keys
are revalidated against the final D1 hash and size and hard-linked locally
(copied when hard links are unavailable); only pending new or changed keys are
requested from the read-only archived bucket:

```bash
npm run migrate:legacy -- bulk-fetch \
  --database ops/legacy-final.sqlite \
  --mapping ops/legacy-final-mapping.json \
  --snapshot ops/legacy-final-raw-snapshot \
  --seed-snapshot ops/legacy-raw-snapshot \
  --seed-database ops/legacy.sqlite \
  --seed-mapping ops/legacy-mapping.json \
  --rclone-source legacy-r2:cf-webmail-starter-mail-objects \
  --rclone-config /secure/legacy-rclone.conf

npm run migrate:legacy -- verify-snapshot \
  --database ops/legacy-final.sqlite \
  --mapping ops/legacy-final-mapping.json \
  --snapshot ops/legacy-final-raw-snapshot
```

Build a version 4 delta stage instead of preparing and applying the full
archive again:

```bash
npm run migrate:legacy -- prepare-delta \
  --baseline-database ops/legacy.sqlite \
  --baseline-stage ops/legacy-stage \
  --database ops/legacy-final.sqlite \
  --mapping ops/legacy-final-mapping.json \
  --snapshot ops/legacy-final-raw-snapshot \
  --stage ops/legacy-final-delta

npm run migrate:legacy -- verify-stage --stage ops/legacy-final-delta
```

The delta inserts only new messages and their rebuilt objects. Existing
messages receive guarded updates only for read, star, archive, delete, and
legacy deletion-time state. Labels, message-label assignments, rules, and
legacy user preferences are synchronized with explicit insert, update, or
delete operations. A removed baseline message, changed raw MIME, changed
headers/body metadata, or changed attachment metadata aborts preparation;
these are not silently treated as a flag update. Every accepted change is
hashed into `changes.jsonl`, recorded in the D1 delta audit tables, and checked
again after application.

Rehearse the delta against the baseline capacity database before touching
remote D1. This copies the database, adds the delta audit schema when the older
capacity artifact predates it, applies the exact delta SQL, and reports final
D1/R2 size against the dated free limits:

```bash
npm run migrate:legacy -- delta-capacity-rehearsal \
  --baseline-database ops/legacy-capacity.sqlite \
  --baseline-stage ops/legacy-stage \
  --stage ops/legacy-final-delta \
  --database ops/legacy-final-capacity.sqlite \
  --output ops/evidence/legacy-final-delta-capacity.json
```

`d1DatabaseFits`, `r2StorageFits`, and `r2DeltaWritesFit` must all be true.
`minimumDeclaredWriteDays` remains a lower bound because D1 index writes are
additional. Apply and audit the delta with the same `bulk-apply` and
`bulk-audit` commands shown below, substituting
`ops/legacy-final-delta` for the stage. An object-free flags/settings-only
delta is valid. Do not accumulate incoming mail in Queues while a multi-day
baseline runs: Workers Free Queue retention is only 24 hours, so production
Email Routing must remain on the archived Worker until the final boundary.
Recheck the current [D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 import accounting](https://developers.cloudflare.com/d1/best-practices/import-export-data/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/), and
[Queue limits](https://developers.cloudflare.com/queues/platform/limits/) when
approving the window; the dated evidence is not a promise that limits cannot
change.

Attachment content hashes and sizes extracted from MIME must match the old D1
attachment/blob rows. Any mismatch, duplicate target raw hash, unavailable raw
object, or invalid metadata makes the stage incomplete. An incomplete archived
stage can be inspected but the shared apply command refuses to apply it.

After provisioning every mapped mailbox and applying all current D1 migrations,
small rehearsals can use the common per-object stage runner:

```bash
npm run migrate:mail -- apply --stage ops/legacy-stage --local --yes
npm run migrate:mail -- apply --stage ops/legacy-stage --remote --yes \
  --config ops/deploy-production/configs/web.wrangler.json
```

For the full archived mailbox set, use the bulk path. Configure a named rclone
S3 remote for the target R2 account outside this repository; keep its access
key and secret in the rclone configuration or environment, never in command
arguments or the deployment manifest.

```bash
npm run migrate:legacy -- bulk-apply \
  --stage ops/legacy-stage \
  --tree ops/legacy-r2-upload \
  --rclone-destination cf-r2:cf-webmail-raw \
  --rclone-config /secure/rclone.conf \
  --database cf-webmail --remote --yes \
  --config ops/deploy-production/configs/web.wrangler.json \
  --transfers 16 --checkers 32
```

Bulk apply materializes a target-key tree using hard links where possible,
runs parallel immutable R2 copy, then performs a full `rclone check --download`
before changing D1. It saves the complete comparison report and its SHA-256,
applies D1 chunks resumably, and finally compares the target migration batch,
message/object counts, direction, flags, and attachment counts with the stage.
It also requires every migrated label, assignment, rule, and preference
provenance row to resolve to its current target row.
An existing remote object with different content or any missing/different
download blocks D1 application.

Immediately before production cutover, rerun the target audit without copying
or inserting anything. Use new report and output paths for every attempt:

```bash
npm run migrate:legacy -- bulk-audit \
  --stage ops/legacy-final-delta \
  --tree ops/legacy-final-r2-upload \
  --rclone-destination cf-r2:cf-webmail-raw \
  --rclone-config /secure/rclone.conf \
  --database cf-webmail --remote \
  --config ops/deploy-production/configs/web.wrangler.json \
  --report ops/evidence/final-r2-check.txt \
  --output ops/evidence/final-legacy-audit.json
```

For a version 4 stage this performs a fresh download-based `rclone check` of
every new staged object and rechecks the delta header, source/mapping/snapshot
hashes, new-message batch, object references, grouped change-source counts,
and existence or absence of each changed target category in D1. The JSON
records the R2 report digest but no mail content or credential. Any mismatch
exits without changing R2 or D1.

Keep the isolated database, inventory, mapping, original SQL, and later R2
snapshot together as cutover evidence. Do not copy credentials or plaintext
secrets from the archived repository into any of these files. Treat every
credential found in an archived configuration, backup, generated file, or
repository history as exposed: rotate or revoke it at the provider and record
non-secret evidence. Removing the file alone is not sufficient.
