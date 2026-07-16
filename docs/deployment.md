# Review-first deployment

Deployment is generated from a non-secret, environment-specific manifest. The
tool does not copy the archived repository's all-in-one setup script and never
creates D1, R2, Queues, Access policies, or Email Routing rules. Resource
provisioning remains an explicit reviewed operation.

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
first. Configure the Access application, onboard every Email Sending domain,
and enable Email Routing for every receiving domain.

```bash
npm run deploy -- preflight --stage ops/deploy-production
```

Preflight checks Wrangler authentication, the exact D1 UUID, R2, all Queues,
Email Sending domain queries, Email Routing settings, the D1 table count, and
three dry builds. The resulting `preflight.json` records check names but does
not persist Wrangler output or account details.

The following checks remain manual because their policy content is not owned by
this repository:

- The Access application protects the exact hostname with an explicit Allow
  policy.
- Email Routing rules target `cf-webmail-ingest` (or the manifest's Ingest
  Worker name).
- SPF, DKIM, and DMARC status is healthy in the Email Service dashboard.

## Apply migrations and deploy

An initial deployment is accepted only when preflight observed an empty D1.
Upgrade mode requires a complete, offline-verified backup from the same remote
D1 and R2 target.

```bash
# Initial empty target
npm run deploy -- deploy --stage ops/deploy-production --yes

# Later upgrade
npm run backup -- create \
  --output ops/backups/pre-deploy \
  --config ops/deploy-production/configs/web.wrangler.json \
  --remote
npm run backup -- verify --backup ops/backups/pre-deploy
npm run deploy -- deploy \
  --stage ops/deploy-production \
  --backup ops/backups/pre-deploy \
  --yes
```

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
