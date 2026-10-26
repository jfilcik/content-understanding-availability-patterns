import { defineConfig } from "@playwright/test";

const port = Number(process.env.CU_OBSERVATORY_TEST_PORT || 5174);
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    trace: "off",
    screenshot: "off",
  },
  webServer: {
    command: `npm start -- --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
