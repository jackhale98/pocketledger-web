import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PW_CHROMIUM; // e.g. /opt/pw-browsers/chromium in dev containers
const chromiumLaunch = executablePath ? { launchOptions: { executablePath } } : {};

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4329/pocketledger-web/',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx astro preview --port 4329',
    url: 'http://localhost:4329/pocketledger-web/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], ...chromiumLaunch } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], ...chromiumLaunch } },
    ...(executablePath ? [] : [{ name: 'mobile-webkit', use: { ...devices['iPhone 14'] } }]),
  ],
});
