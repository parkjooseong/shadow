import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [{
    command: 'node server/index.mjs',
    url: 'http://127.0.0.1:18787/api/health',
    env: { PORT: '18787', SHADOW_ORIGIN: 'http://127.0.0.1:4173', SHADOW_PUBLIC_URL: 'http://127.0.0.1:4173', SHADOW_DB_PATH: ':memory:' },
    reuseExistingServer: false,
  }, {
    command: 'npm.cmd run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    env: { SHADOW_API_TARGET: 'http://127.0.0.1:18787' },
    reuseExistingServer: false,
  }],
});
