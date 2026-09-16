import { defineConfig, devices } from '@playwright/test';

const ACCOUNT_SYNC_SPEC_PATTERN = /(?:^|[\\/])account-sync\.spec\.ts$/u;
const accountSyncSpecSelected = process.argv.some((argument) => ACCOUNT_SYNC_SPEC_PATTERN.test(argument));
const accountSyncE2e = process.env.ACCOUNT_SYNC_E2E === 'true' || accountSyncSpecSelected;
const e2eDataDir = accountSyncE2e ? '.tmp-e2e-account-data' : '.tmp-e2e-data';
const accountSyncEnv = accountSyncE2e ? 'ACCOUNT_SYNC_ENABLED=true' : 'ACCOUNT_SYNC_ENABLED=false';

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
  projects: [{
    name: 'chromium',
    testIgnore: accountSyncE2e ? undefined : ACCOUNT_SYNC_SPEC_PATTERN,
    use: { ...devices['Desktop Chrome'] }
  }],
  webServer: {
    command: `npm run build && PORT=4173 NODE_ENV=test RATE_LIMIT_MAX=1000 TRUSTED_ORIGINS=http://127.0.0.1:4173 DATA_DIR=${e2eDataDir} ${accountSyncEnv} LOG_LEVEL=warn node tests/e2e/start-server.mjs`,
    url: 'http://127.0.0.1:4173/healthz',
    reuseExistingServer: accountSyncE2e ? false : !process.env.CI,
    timeout: 120_000
  }
});
