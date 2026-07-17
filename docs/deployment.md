# Review-first deployment

Deployment is generated from a non-secret, environment-specific manifest. The
tool does not copy the archived repository's all-in-one setup script and never
creates D1, R2, Queues, Access policies, or Email Routing rules. Resource
provisioning remains an explicit reviewed operation.

This runbook covers configuration and Worker upload. The complete definition
of source-, account-, data-, deploy-, and cutover-readiness is in
[`release-readiness.md`](release-readiness.md).

The workflow is:

1. `plan`: validate one manifest and generate three production-only Wrangler
   configurations bound to the same account, D1, R2, Queues, hostname, and
   Access application.
2. `verify`: hash every generated configuration and bind the stage to the exact
   clean Git commit that produced it.
3. `preflight`: read remote resource state and run all three Wrangler dry
   builds. It performs no remote mutation.
4. `deploy`: require explicit confirmation, apply D1 migrations, then deploy
   Jobs, Ingest, and Web in dependency order. In upgrade mode it first records
   the version currently receiving 100% of traffic for every Worker.
5. `postflight`: prove that every Worker moved to a new version, the current D1
   schema is complete, the Web health endpoint is reachable, and durable work
   has drained before allowing traffic cutover.

## Create a deployment manifest

Copy `tools/examples/deployment.v1.json` into the ignored `ops/` directory and
replace every placeholder. Use `mode: "initial"` only for a new D1 database
with no user tables. Use `mode: "upgrade"` for every later deployment.

The manifest contains account and resource identifiers, but no API tokens,
Access service-token secrets, or email credentials. Do not add secrets to it.

```bash
cp tools/examples/deployment.v1.json ops/deployment.production.json
npm run deploy -- plan \
  --manifest ops/deployment.production.json \
  --stage ops/deploy-production
npm run deploy -- verify --stage ops/deploy-production
```

`plan` requires a clean worktree and refuses an existing nonempty stage. Review
`manifest.json` and all files below `configs/`. Generated Web configuration
uses a Custom Domain and disables `workers.dev` and preview URLs. Ingest and
Jobs also disable public URLs.

## Remote preflight

Authenticate Wrangler and create the shared D1, R2 bucket, and four Queues
first. Configure the Access application, enable Email Routing for every
receiving domain, and verify every declared sender domain in SMTP2GO.

```bash
npm run deploy -- preflight --stage ops/deploy-production
```

Preflight checks Wrangler authentication, the exact D1 UUID, R2, all Queues,
Email Routing settings, the D1 table count, and three dry builds. The resulting
`preflight.json` records check names but does not persist Wrangler output or
account details. `email.outboundProvider` must be `smtp2go`, and
`email.senderDomains` declares the sender domains that provisioning is allowed
to use.

Preflight deliberately does not read an SMTP2GO key or call its API. Before
deploying, manually confirm each sender domain under SMTP2GO **Sending >
Verified Senders**, review the current free-plan quota, and create a new API key
whose only endpoint permission is `/email/send`. SMTP2GO requires verified
senders and recommends domain verification for SPF/DKIM alignment; its current
API and plan behavior are documented in the
[SMTP2GO API guide](https://developers.smtp2go.com/docs/getting-started) and
[free-plan guide](https://support.smtp2go.com/hc/en-gb/articles/223087947-Free-Plan).

For an initial deployment, each Queue must have zero producer and consumer
bindings. For an upgrade, every existing binding must belong to the three
Workers named by the manifest. This prevents a generic Queue name from joining
the rebuilt deployment to the archived Worker.

The following checks remain manual because their policy content is not owned by
this repository:

- The Access application protects the exact hostname with an explicit Allow
  policy.
- Email Routing rules target `cf-webmail-ingest` (or the manifest's Ingest
  Worker name).
- SMTP2GO shows every declared sender domain as verified, and its dedicated API
  key is restricted to `/email/send`.
- SPF, DKIM, and DMARC alignment is healthy for a real SMTP2GO canary.

## Apply migrations and deploy

An initial deployment is accepted only when preflight observed an empty D1.
Upgrade mode requires a complete, offline-verified backup from the same remote
D1 and R2 target. Create the ignored secret file with a local editor, never in
shell history:

```json
{"SMTP2GO_API_KEY":"api-REPLACE_WITH_32_GENERATED_CHARACTERS"}
```

Save it as `ops/deployment-secrets.production.json`, set mode `0600`, and keep
exactly that one key:

```bash
chmod 600 ops/deployment-secrets.production.json
```

The deploy command validates the file name set, key format, and permissions.
It passes the file only to the Jobs `wrangler deploy --secrets-file` call; the
value is not copied into the stage, generated configuration, report, D1, R2, or
Queue. Cloudflare documents this code-and-secret upload flow in
[Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

```bash
# Initial empty target
npm run deploy -- deploy \
  --stage ops/deploy-production \
  --secrets-file ops/deployment-secrets.production.json \
  --yes

# Later upgrade
npm run backup -- create \
  --output ops/backups/pre-deploy \
  --config ops/deploy-production/configs/web.wrangler.json \
  --remote
npm run backup -- verify --backup ops/backups/pre-deploy
npm run deploy -- deploy \
  --stage ops/deploy-production \
  --secrets-file ops/deployment-secrets.production.json \
  --backup ops/backups/pre-deploy \
  --yes
```

## Post-deploy gate

Create a Cloudflare Access service token accepted by the Web application's
policy, export it only in the operator environment, and run postflight. The
secret is sent as an HTTP header and is never written into the stage report.

```bash
export CF_ACCESS_CLIENT_ID='...access service token id...'
export CF_ACCESS_CLIENT_SECRET='...access service token secret...'
npm run deploy -- postflight --stage ops/deploy-production
```

Postflight checks the three active Worker versions, all 33 application tables,
and `GET /healthz`. It also reports unresolved inbound handoffs, outbound
deliveries, dead letters, storage issues, and active or failed retention runs.
When any durable work remains it still writes `postflight.json`, sets
`cutoverReady` to `false`, and exits with status 2. Inspect and resolve each
recorded blocker, then rerun with `--force`. A successful postflight does not
replace the manual canary send/receive and Access authorization checks listed
in the report.

The end-to-end archived-system freeze, final import, Email Routing boundary,
acceptance tests, and legacy rollback limitations are defined in
[`cutover.md`](cutover.md). Do not switch production routing from this deployment
document alone.

## Continuous verification

`.github/workflows/ci.yml` runs the generated-binding check, TypeScript checks,
Node operations tests, Miniflare Workers tests, and all three dry builds on
pushes and pull requests. Protect the default branch by requiring this `verify`
job.

The manually dispatched `Production read-only preflight` workflow is restricted
to the default branch and the `production-readonly` GitHub environment. Add
required reviewers to that environment and configure these environment
secrets:

- `CLOUDFLARE_ACCOUNT_ID`: the exact account in the deployment manifest.
- `CLOUDFLARE_API_TOKEN`: a dedicated token limited to the read permissions
  needed for Workers, D1, R2, Queues, and Email Routing inspection.
- `DEPLOYMENT_MANIFEST_JSON`: the complete non-placeholder deployment manifest.

The workflow writes the manifest and generated stage below the ephemeral runner
temporary directory and uploads only `preflight.json`. It cannot run migrations,
deploy Workers, change routing, or create a backup. Keep production mutation on
a secured operator host because upgrade backups contain complete private mail
and must not become unencrypted CI artifacts.

Preflight expires after one hour. Deployment stops on the first failed
migration or Worker upload and does not attempt an unsafe automatic rollback.
Before any mutation, it writes `rollback-plan.json` into the stage. A retry
reuses that file instead of replacing the original recovery point with a
partially deployed version. Initial deployments record that no previous Worker
version exists.

To restore the three recorded Worker versions after disabling or restoring the
appropriate Email Routing rule, run:

```bash
npm run deploy -- rollback \
  --stage ops/deploy-production \
  --reason "failed production smoke checks" \
  --yes
```

Rollback is deliberately explicit and restores Web, Ingest, then Jobs. It does
not revert D1 migrations, D1 data, R2 objects, Queues, Email Routing, Access, or
DNS. Migrations must therefore remain backward-compatible with the previous
Worker version. If data recovery is required, restore a verified backup into
new D1 and R2 resources and deploy a newly reviewed manifest targeting them;
never overwrite the active stores as an emergency shortcut.

Upgrade backup metadata must name the same D1 and R2 resources and the exact
generated Web configuration, which pins the Cloudflare account used to read
them. It deliberately does not enable Email Routing or change inbound MX
records, so a code deploy cannot cut mail flow over by itself. Deploying Web
does attach the manifest's Custom Domain and can switch Web traffic; use a
staging hostname until the replacement UI is ready. Provision users and
mailboxes with the operations CLI, complete post-deploy send/receive checks,
and only then enable the production routing rule.
