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
integrity count is nonzero.

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

npm run ops -- plan \
  --manifest ops/provision.legacy.json \
  --output ops/provision.legacy.sql
```

The manifest initially assigns one explicitly identified owner to every mapped
mailbox. Edit and revalidate it if ownership differs. Active local alias or
representative rows with exactly one mapped local destination are included as
mailbox aliases. The separate review file preserves account receive/send/kind
flags, domains, external or multi-target aliases, and archived membership
suggestions. Resolve every review item before applying the SQL: forwarding,
quarantine, log-only, DNS, and domain routing are external Cloudflare policy,
and a membership may be granted only after its exact Access issuer/subject has
been provisioned. Never treat an archived access email as an authorization key.

The generated SQL must be applied before the converted mail stage. Every stage
now starts with a prerequisite guard for the mapped mailbox ID, mapped primary
address, and at least one owner; a missing or conflicting directory entry stops
the D1 chunk before configuration or message rows are inserted.

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

To read the archived bucket directly, select the target explicitly. The
command only downloads objects and does not mutate the source bucket:

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
  --stage ops/legacy-final-stage \
  --tree ops/legacy-final-r2-upload \
  --rclone-destination cf-r2:cf-webmail-raw \
  --rclone-config /secure/rclone.conf \
  --database cf-webmail --remote \
  --config ops/deploy-production/configs/web.wrangler.json \
  --report ops/evidence/final-r2-check.txt \
  --output ops/evidence/final-legacy-audit.json
```

This performs a fresh download-based `rclone check` of every staged object and
rechecks the migration batch, source hashes, per-account direction and flag
counts, attachment counts, object-reference count, and configuration
provenance in D1. The JSON records the R2 report digest but no mail content or
credential. Any mismatch exits without changing R2 or D1.

Keep the isolated database, inventory, mapping, original SQL, and later R2
snapshot together as cutover evidence. Do not copy credentials or plaintext
secrets from the archived repository into any of these files.
