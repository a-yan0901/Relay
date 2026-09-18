import { defineConfig, devices } from '@playwright/test';

const ACCOUNT_SYNC_SPEC_PATTERN = /(?:^|[\\/])account-sync\.spec\.ts$/u;
const accountSyncSpecSelected = process.argv.some((argument) => ACCOUNT_SYNC_SPEC_PATTERN.test(argument));
const accountSyncE2e = process.env.ACCOUNT_SYNC_E2E === 'true' || accountSyncSpecSelected;
const e2eDataDir = accountSyncE2e ? '.tmp-e2e-account-data' : '.tmp-e2e-data';
const e2eServerEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
  PORT: '4173',
  NODE_ENV: 'test',
  RATE_LIMIT_MAX: '1000',
  TRUSTED_ORIGINS: 'http://127.0.0.1:4173',
  DATA_DIR: e2eDataDir,
  ACCOUNT_SYNC_ENABLED: accountSyncE2e ? 'true' : 'false',
  LOG_LEVEL: 'warn'
};

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  // All specs share one isolated DATA_DIR through the single webServer process.
  workers: 1,
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
    command: 'npm run build && node tests/e2e/start-server.mjs',
    env: e2eServerEnv,
    url: 'http://127.0.0.1:4173/healthz',
    reuseExistingServer: accountSyncE2e ? false : !process.env.CI,
    timeout: 120_000
  }
});
