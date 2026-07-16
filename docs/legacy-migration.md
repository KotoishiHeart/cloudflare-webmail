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
flag counts, attachment counts, raw bytes, R2 reference counts, and relational
integrity failures. Exit status `2` means the inventory was written but at
least one integrity count is nonzero.

Review the generated mapping. Every account containing messages must either
map to one unique target mailbox or have an explicit exclusion with a reason.
The generated target UUIDs are deterministic, but the corresponding mailboxes
must be included in the reviewed provisioning manifest before mail is applied.

```bash
npm run migrate:legacy -- validate-mapping \
  --database ops/legacy.sqlite \
  --mapping ops/legacy-mapping.json
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
The old record ID, account, Bcc, compose/send metadata, deletion time, and old
R2 keys are retained in dedicated migration provenance tables.

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
rehearse and then apply through the common stage runner:

```bash
npm run migrate:mail -- apply --stage ops/legacy-stage --local --yes
npm run migrate:mail -- apply --stage ops/legacy-stage --remote --yes \
  --config ops/deploy-production/configs/web.wrangler.json
```

Keep the isolated database, inventory, mapping, original SQL, and later R2
snapshot together as cutover evidence. Do not copy credentials or plaintext
secrets from the archived repository into any of these files.
