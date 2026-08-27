import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.E2E_PORT ?? "4799";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["list"], ["./e2e/coverage-reporter.ts"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Boot a dedicated e2e broker on a scratch DB — never the user's :4733
    // instance. Builds the UI dist first only when missing.
    command: [
      "cd ../..",
      "rm -f /tmp/amb-e2e.db*",
      "VITE_E2E_COVERAGE=1 npm run build -w @amb/ui",
      `BROKER_DB=/tmp/amb-e2e.db BROKER_TOKEN=${process.env.E2E_TOKEN ?? "test-token"} BROKER_PORT=${PORT} npx tsx packages/server/src/index.ts`,
    ].join(" && "),
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
