import { defineConfig } from "@playwright/test";

// Reuses running dev servers (Next allows one dev server per app directory); starts them otherwise.
export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://localhost:3000" },
  webServer: [
    {
      command: ".venv/bin/uvicorn app.main:app --port 8000",
      cwd: "../../services/planner",
      url: "http://127.0.0.1:8000/health",
      reuseExistingServer: true,
    },
    {
      command: "npx next dev -p 3000",
      url: "http://localhost:3000/api/health",
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
