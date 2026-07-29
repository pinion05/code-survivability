import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4417",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command:
      "GITHUB_TOKEN=e2e-public-token PUBLIC_ORIGIN=http://127.0.0.1:4417 HOST=127.0.0.1 PORT=4417 node ./dist/server/entry.mjs",
    url: "http://127.0.0.1:4417/healthz",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
