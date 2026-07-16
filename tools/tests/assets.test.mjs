import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const PUBLIC = resolve('apps/web/public');

test('PWA manifest and icons form a complete install surface', async () => {
  const manifest = JSON.parse(await readFile(resolve(PUBLIC, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512']);
  for (const icon of manifest.icons) {
    const content = await readFile(resolve(PUBLIC, icon.src.slice(1)));
    assert.deepEqual([...content.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.equal(content.readUInt32BE(16), width);
    assert.equal(content.readUInt32BE(20), height);
  }
});

test('service worker precache contains only existing static assets', async () => {
  const source = await readFile(resolve(PUBLIC, 'service-worker.js'), 'utf8');
  const shellBlock = source.match(/const SHELL = \[([\s\S]*?)\];/u)?.[1] ?? '';
  const paths = [...shellBlock.matchAll(/'([^']+)'/gu)].map((match) => match[1]);
  assert.ok(paths.length > 20);
  assert.equal(paths.some((path) => path.startsWith('/api/')), false);
  assert.match(source, /url\.pathname\.startsWith\('\/api\/'\)/u);
  for (const path of paths) {
    if (path === '/') continue;
    await readFile(resolve(PUBLIC, path.slice(1)));
  }
});

test('mail and administration shells expose accessible landmarks', async () => {
  const [mail, admin] = await Promise.all([
    readFile(resolve(PUBLIC, 'index.html'), 'utf8'),
    readFile(resolve(PUBLIC, 'admin.html'), 'utf8'),
  ]);
  assert.match(mail, /href="#mail-main"/u);
  assert.match(mail, /id="admin-button"[^>]+hidden/u);
  assert.match(admin, /href="#admin-main"/u);
  assert.match(admin, /data-admin-section="retention"/u);
  assert.match(admin, /role="tabpanel"/u);
});
