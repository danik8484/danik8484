import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const chromiumPath = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:8787",
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    ...devices["Pixel 7"],
    launchOptions: existsSync(chromiumPath) ? { executablePath: chromiumPath } : undefined,
  },
});
