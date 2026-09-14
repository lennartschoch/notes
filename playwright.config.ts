import { defineConfig, devices } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.E2E_PORT ?? 4100);
const baseURL = `http://127.0.0.1:${port}`;
const dataDir = join(process.cwd(), "e2e", ".data");

// Every run starts from an empty store so the suite always begins on a clean
// slate, regardless of what previous runs wrote.
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build -w client && npm run start:e2e -w server",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: "test",
      PORT: String(port),
      NOTES_DATA_FILE: join(dataDir, "notes.json"),
      STICKERS_DATA_FILE: join(dataDir, "stickers.json"),
      STICKERS_DIR: join(dataDir, "stickers"),
    },
  },
});
