# Release readiness boundary

The repository can provide deployable code and evidence-generating tools; it
cannot prove that a particular Cloudflare account is deployed without remote
credentials, resource state, Access policy, routing state, and real mail
delivery evidence. Use the gates below in order.

## 1. Source gate

Run from a clean commit with Node.js 22 or later:

```bash
npm ci
npm run audit:prod
npm run typecheck
npm run test:node
npm run test:workers
npm run build:dry
git diff --check
```

`npm run test:workers` is mandatory release evidence. It exercises the actual
Workers runtime test pool with D1, R2, Queue entrypoints, authentication,
mailbox authorization, inbound persistence, outbound idempotency, search,
rules, administration, retention, and retry behavior. Type checking, Node
tests, or a Wrangler dry build cannot substitute for it. The default-branch
`verify` check must be green for the exact commit selected for deployment.

## 2. Account gate

Create or identify the account-owned resources listed in
[`operations.md`](operations.md): one D1 database, one private R2 bucket, four
Queues, three Worker names, a Web Custom Domain, a Cloudflare Access
self-hosted application, Email Routing domains, and verified Email Sending
domains. Keep production routing pointed at the archived Worker during this
gate.

Copy the deployment and provisioning examples into ignored `ops/` paths.
Replace every placeholder, keep identifiers stable, and never place API,
Access, R2, or email secrets in either manifest.

## 3. Read-only remote gate

Generate a stage, verify its clean-commit hashes, and run preflight:

```bash
npm run deploy -- plan \
  --manifest ops/deployment.production.json \
  --stage ops/deploy-production
npm run deploy -- verify --stage ops/deploy-production
npm run deploy -- preflight --stage ops/deploy-production
```

Preflight must prove the authenticated account, exact D1 UUID, R2 bucket,
Queues, Email Sending and Routing domains, D1 initial/upgrade state, and all
three production dry builds. Manual review must separately confirm the Access
Allow policy, Email Routing Worker target, and SPF/DKIM/DMARC state.

## 4. Data gate

Provision identities, memberships, mailboxes, and aliases with the reviewed
operations SQL. Rehearse the archived migration on the separated canary
deployment. Require:

- zero unexplained source inventory or relational-integrity failures;
- every nonempty archived account mapped or explicitly excluded with reason;
- a generated provisioning review with every account policy, domain, external
  alias, and membership suggestion explicitly resolved;
- `legacy-provisioning-verification.json` reports `ready: true` and binds the
  source, mapping, exact provisioning manifest, Access issuer, mail domains,
  review, and deployment manifest by digest;
- every mapped mailbox ID and primary address provisioned with at least one
  verified Access-backed owner before any migration chunk is applied;
- the frozen bulk source-key list matches the mapped archive and read-only
  rclone acquisition completes without per-object process fan-out;
- a fully verified archived raw snapshot and complete conversion stage;
- successful download-based R2 comparison;
- matching per-account D1 message, direction, flag, attachment, and object
  reference counts;
- matching migrated label, message-label, rule, and user-preference provenance
  with every target row still present;
- a portable target backup that verifies offline and a representative restore
  or download check.

The exact commands and evidence files are defined in
[`legacy-migration.md`](legacy-migration.md) and
[`backup-and-restore.md`](backup-and-restore.md).

## 5. Deployment gate

Initial deployment requires an empty target D1. Every upgrade requires a fresh
verified backup tied to the same generated Web configuration and D1/R2 target.
Deployment applies migrations and uploads Jobs, Ingest, then Web. Upgrade mode
writes `rollback-plan.json` before the first mutation and refuses split Worker
traffic as an ambiguous rollback point.

Run authenticated postflight with an Access service token held only in the
operator environment. It must prove new active Worker versions, all 31 D1
tables, `/healthz`, and no unresolved handoffs, outbound work, dead letters,
storage issues, or retention runs. `cutoverReady: false` or exit status 2 is a
hard stop.

## 6. Real-service gate

On a canary hostname and address, use real Access identities and send mail
through the real service boundaries. Verify:

- unique inbound plain text, sanitized HTML, Unicode headers, and attachment;
- exactly-once visibility after Queue redelivery;
- outbound new/reply/forward with Bcc and attachment;
- thread headers, From restriction, attachment digest, and provider outcome;
- reader/operator/owner/system-administrator allow and deny boundaries;
- SPF, DKIM, and DMARC alignment at the recipient;
- PWA shell behavior without offline API/body/attachment caching.

There is intentionally no privileged inbound simulation endpoint. A dry build
or direct database insert is not real-service evidence.

## 7. Cutover gate

Follow [`cutover.md`](cutover.md) exactly: freeze archived Web mutations,
drain archived outbound work, deploy without changing routing, switch the
Email Routing Worker target, create the final archived snapshot, repeat the
deterministic import, run a fresh bulk audit and postflight, repeat production
canaries, then reopen Access.

The Email Routing timestamp is the irreversible data boundary. Code rollback
does not reverse D1 migrations, R2 writes, Queue messages, routing, Access, or
mail accepted after that timestamp. Preserve both systems and reconcile the
interval explicitly.

## Readiness interpretation

| State | Required evidence |
| --- | --- |
| Source-ready | Clean commit; full CI including Worker tests; dry builds pass. |
| Account-ready | Resources and policies exist; generated stage verifies; preflight passes. |
| Data-ready | Provisioning, rehearsal migration, full R2/D1 audit, backup, and representative recovery checks pass. |
| Deploy-ready | Source-, account-, and data-ready evidence is attached to the approved change. |
| Cutover-ready | Deployed versions pass postflight and real canaries; `cutoverReady` is true. |
| Deployed | Cloudflare version IDs, hostname health, routing target, boundary time, canary results, and evidence paths are recorded. |

Without the final row's remote evidence, the accurate statement is
"implementation complete, remote deployment not yet proven," not "deployed."
