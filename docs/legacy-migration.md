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

Keep the isolated database, inventory, mapping, original SQL, and later R2
snapshot together as cutover evidence. Do not copy credentials or plaintext
secrets from the archived repository into any of these files.
