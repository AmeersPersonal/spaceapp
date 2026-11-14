import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      // Never reach real Cloudflare services (Workers AI / Vectorize) from tests.
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
          // Force unauthenticated, offline defaults regardless of local .dev.vars.
          EARTHDATA_TOKEN: '',
          INGEST_API_KEY: '',
          AUTH0_DOMAIN: '',
          AUTH0_CLIENT_ID: '',
          AUTH0_CLIENT_SECRET: '',
          AUTH0_SESSION_ENCRYPTION_KEY: '',
          APP_BASE_URL: '',
          FIRMS_MAP_KEY: '',
          GOOGLE_MAPS_API_KEY: '',
          PROCESSOR_URL: '',
          ASF_SEARCH_URL: 'https://asf.test/services/search/param',
        },
      },
    })),
  ],
  test: {
    setupFiles: ['./tests/setup.js'],
  },
});
