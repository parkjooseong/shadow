import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  // All workers share one API server, which permits four concurrent password jobs.
  workers: 4,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [{
    command: 'node server/index.mjs',
    url: 'http://127.0.0.1:18787/api/health',
    env: { PORT: '18787', SHADOW_ORIGIN: 'http://127.0.0.1:4173', SHADOW_PUBLIC_URL: 'http://127.0.0.1:4173', SHADOW_DB_PATH: ':memory:', SHADOW_MAIL_MODE: 'outbox' },
    reuseExistingServer: false,
  }, {
    command: `${process.platform === 'win32' ? 'npm.cmd' : 'npm'} run dev -- --host 127.0.0.1 --port 4173`,
    url: 'http://127.0.0.1:4173',
    env: { SHADOW_API_TARGET: 'http://127.0.0.1:18787' },
    reuseExistingServer: false,
  }],
});
