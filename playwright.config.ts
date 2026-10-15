import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests run against the production build (so the real service worker and
 * precache are exercised) with no Supabase configured. Chromium's fake media device
 * supplies a microphone signal; it cannot validate real speech recognition quality,
 * which must be checked on target devices (docs/TESTING.md).
 */
const fakeMic = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    serviceWorkers: 'allow',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: [/mobile\.spec\.ts/],
      use: { ...devices['Desktop Chrome'], permissions: ['microphone'], launchOptions: { args: fakeMic } },
    },
    {
      name: 'mobile',
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices['Pixel 7'], permissions: ['microphone'], launchOptions: { args: fakeMic } },
    },
  ],
  webServer: {
    command: 'npx vite build && node scripts/serve-dist.mjs',
    url: 'http://localhost:4173',
    // Always build and serve fresh, so tests never run against a stale build.
    reuseExistingServer: false,
    timeout: 180_000,
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '' },
  },
});
