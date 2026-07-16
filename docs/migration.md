# Mail migration runbook

The migration tool uses an inspectable, resumable stage. It never reads the
old database and writes the new production database in one step.

Supported sources are:

- `maildir`: recursively imports regular files below Maildir `cur` and `new`
  directories and maps `S`, `F`, and `T` flags to read, starred, and deleted.
- `eml-tree`: recursively imports `.eml` and `.eml.gz`. This is the adapter for
  raw object trees restored from `cloudflare-webmail-archived` backup bundles.

Run one stage per target mailbox and per direction. The target user, mailbox,
primary address, and migrations must already exist. The tool does not create
identities or infer mailbox ownership from old schema revisions.

## Prepare

```bash
npm run migrate:mail -- prepare \
  --source /srv/mail/example.com/user/Maildir \
  --format maildir \
  --stage ops/migration-user-inbound \
  --mailbox-id 019c315c-1f20-7000-8000-000000000000 \
  --address user@example.com \
  --direction inbound
```

For an old raw backup, use `--format eml-tree` and point `--source` at the
directory containing its raw `.eml.gz` objects. Use `--direction outbound` for
a separately restored sent-mail tree.

Preparation performs no Cloudflare calls. It parses MIME locally, creates
deterministic message IDs from mailbox ID plus raw SHA-256, removes exact raw
duplicates within the stage, and writes:

- `manifest.json`: source mapping and counts.
- `objects.jsonl` plus `objects/`: R2 keys, local files, sizes, and SHA-256.
- `d1/*.sql`: chunks of at most 50 idempotent message inserts, with size and
  SHA-256 recorded in the manifest.
- `failures.jsonl`: unreadable or over-limit source files.

A nonzero failed count makes the prepare command exit with status 2. Review it
before continuing; do not ignore messages silently.

## Verify and apply

```bash
npm run migrate:mail -- verify --stage ops/migration-user-inbound
npm run migrate:mail -- apply --stage ops/migration-user-inbound --local --yes
npm run migrate:mail -- apply --stage ops/migration-user-inbound --remote --yes \
  --config ops/deploy-production/configs/web.wrangler.json
```

For an isolated local rehearsal, add `--persist-to /tmp/cf-webmail-migration`
to both the migration command used to initialize that local D1 and `apply`.

Verification hashes every staged object. Apply uploads all R2 objects before
executing any D1 SQL, and records a target-specific `apply-state.*.json` after
each successful object and SQL chunk. Local rehearsal and remote application
therefore have independent progress, while re-running the same target resumes.

The importer preserves the raw MIME and extracted bodies/attachments but does
not reproduce legacy full-text indexes, provider attempt logs, or old sessions.
An imported outbound message becomes sent history only; it is never published
to the outbound Queue. If the destination already contains the same raw SHA
under another message ID, D1 deduplication can leave newly uploaded stage
objects unreferenced. Run backup verification and an object-reference audit
before deleting any old source.
