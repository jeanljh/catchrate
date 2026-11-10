import { defineConfig, devices } from '@playwright/test';
import type { PlaywrightTestConfig } from '@playwright/test';

const PORT = Number(process.env.PORT || 4321);

export const shopConfig: PlaywrightTestConfig = {
  testDir: './tests',
  fullyParallel: true,
  reporter: 'line',
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: 'node server.js',
    url: `http://127.0.0.1:${PORT}/api/user`,
    reuseExistingServer: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
};

export default defineConfig(shopConfig);
