import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

describe('GitHub workflow safety boundaries', () => {
  it('runs the complete verification suite on pushes and pull requests', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
    assert.match(workflow, /push:/u);
    assert.match(workflow, /pull_request:/u);
    assert.match(workflow, /actions\/checkout@v6/u);
    assert.match(workflow, /actions\/setup-node@v6/u);
    assert.match(workflow, /npm run typecheck/u);
    assert.match(workflow, /npm run test:node/u);
    assert.match(workflow, /npm run test:workers/u);
    assert.match(workflow, /npm run build:dry/u);
  });

  it('keeps the GitHub production workflow read-only and protected', async () => {
    const workflow = await readFile('.github/workflows/production-preflight.yml', 'utf8');
    assert.match(workflow, /workflow_dispatch:/u);
    assert.match(workflow, /environment: production-readonly/u);
    assert.match(workflow, /CLOUDFLARE_API_TOKEN:.*secrets\.CLOUDFLARE_API_TOKEN/u);
    assert.match(workflow, /DEPLOYMENT_MANIFEST_JSON:.*secrets\.DEPLOYMENT_MANIFEST_JSON/u);
    assert.match(workflow, /manifest accountId does not match the protected account/u);
    assert.match(workflow, /npm run deploy -- preflight/u);
    assert.doesNotMatch(workflow, /npm run deploy -- deploy/u);
    assert.doesNotMatch(workflow, /npm run backup/u);
  });
});
