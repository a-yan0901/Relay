import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && PORT=4173 NODE_ENV=test RATE_LIMIT_MAX=1000 TRUSTED_ORIGINS=http://127.0.0.1:4173 DATA_DIR=.tmp-e2e-data LOG_LEVEL=warn node tests/e2e/start-server.mjs',
    url: 'http://127.0.0.1:4173/healthz',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
