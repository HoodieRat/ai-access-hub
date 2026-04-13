import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

const port = process.env.HUB_PORT ?? '3000';
const baseURL = process.env.HUB_BASE_URL ?? `http://127.0.0.1:${port}`;
const command = process.platform === 'win32' ? 'npm.cmd run dev' : 'npm run dev';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command,
    url: `${baseURL}/dashboard`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});