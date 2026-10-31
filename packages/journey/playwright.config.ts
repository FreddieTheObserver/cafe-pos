import { defineConfig } from '@playwright/test';
import { PORTS, URLS, apiEnv } from './src/env';

const web = (
  app: 'kiosk' | 'staff' | 'board',
  port: number,
  env: Record<string, string> = {},
) => ({
  command: `pnpm --filter @cafepos/${app} build && pnpm --filter @cafepos/${app} exec vite preview --port ${port} --strictPort`,
  url: `http://localhost:${port}`,
  env: { VITE_API_URL: URLS.api, ...env },
  reuseExistingServer: false,
  timeout: 120_000,
});

export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node --experimental-strip-types scripts/start-api.mjs',
      url: `${URLS.api}/readyz`,
      env: apiEnv(),
      reuseExistingServer: false,
      timeout: 180_000,
    },
    // A poll slower than any assertion, so a screen only changes in time if the push reached it.
    web('kiosk', PORTS.kiosk, {
      VITE_PAYMENTS: 'fake',
      VITE_TRACKER_POLL_MS: '60000',
      VITE_IDLE_MS: '600000',
    }),
    web('staff', PORTS.staff),
    web('board', PORTS.board),
  ],
});
