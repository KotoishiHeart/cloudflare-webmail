# Backup and restore runbook

The portable backup combines a Wrangler D1 SQL export with every canonical R2
object referenced by `messages` and `attachments`. It is separate from D1 Time
Travel: Time Travel is useful for short-window recovery in the same database,
while this bundle can be verified offline and restored into new resources.

Backups contain complete raw mail, bodies, and attachments. Store the directory
as sensitive data, encrypt it at rest, restrict access, and define retention.

## Create and verify

```bash
npm run backup -- create --output ops/backups/2026-07-16 --local
npm run backup -- create --output ops/backups/2026-07-16 --remote \
  --config ops/deploy-production/configs/web.wrangler.json
npm run backup -- verify --backup ops/backups/2026-07-16
```

Creation performs these steps:

1. Exports the D1 schema and data to `d1.sql` with `wrangler d1 export`.
2. Queries D1 for canonical raw, text, HTML, and attachment R2 keys.
3. Downloads each object with resumable per-object sidecars.
4. Writes `manifest.json` last, with SHA-256 and byte size for D1 and every
   object.

Wrangler currently does not expose `--persist-to` for `d1 export`, so local
backup creation always reads the normal local Wrangler state. Remote creation
requires an authenticated Wrangler profile. D1 export can temporarily block
database requests and should be scheduled for a quiet period.

`verify` rejects altered bytes, unsafe paths, duplicate object keys, count
mismatches, and objects not referenced by the exported D1 SQL. Run it after
copying a bundle and as a periodic restore-readiness check.

Staged inbound objects and other unreferenced R2 orphans are intentionally not
included. They are not committed mail records and require a separate retention
policy.

## Restore into new empty resources

Create a new empty D1 database and R2 bucket first; do not point restore at the
active production resources. Then run:

```bash
npm run backup -- restore \
  --backup ops/backups/2026-07-16 \
  --database cf-webmail-restore \
  --bucket cf-webmail-raw-restore \
  --config ops/deploy-restore/configs/web.wrangler.json \
  --remote --empty-target --yes
```

Restore verifies the entire bundle, queries `sqlite_master` and refuses a D1
target with user tables, uploads all R2 objects, and only then imports `d1.sql`.
The `--empty-target` flag is an explicit assertion that the R2 bucket is also
new and empty; Wrangler does not provide a bulk object-list check for this
workflow. Target-specific restore state makes retries resumable.

After restore, run the status CLI and verify representative raw/body/attachment
downloads before changing routing or Access configuration. A restore does not
deploy Workers, change Email Routing, modify Access, or switch DNS.

Current command references:

- [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [R2 Wrangler object commands](https://developers.cloudflare.com/r2/reference/wrangler-commands/)
