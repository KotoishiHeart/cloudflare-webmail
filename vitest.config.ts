import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './apps/web/wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            new URL('./migrations', import.meta.url).pathname,
          ),
        },
      },
    })),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-d1.ts'],
  },
});
