import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  outputDir: './tmp/browser/results',
  workers: 1,
  timeout: 90_000,
  use: { channel: 'msedge', headless: true, baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: 'node scripts/serve-static.mjs 4173',
    url: 'http://127.0.0.1:4173/editor/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
