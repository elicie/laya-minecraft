import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: "../../tests/web",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5175",
    headless: true,
    viewport: { width: 1440, height: 1100 },
  },
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js --config apps/web/vite.config.ts --port 5175",
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    url: "http://127.0.0.1:5175",
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
