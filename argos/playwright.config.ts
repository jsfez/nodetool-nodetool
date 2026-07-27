import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

/**
 * Argos visual testing on the NodeTool Storybook.
 *
 * The captured surface is the static Storybook that `chromatic.config.json`
 * already points at: `buildScriptName: build-storybook` in `storybookBaseDir:
 * web`, so the review covers exactly the stories the Chromatic workflow does.
 */
const PORT = 6112;
const STATIC_DIR = fileURLToPath(
  new URL("../web/storybook-static", import.meta.url)
);

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  fullyParallel: true,
  forbidOnly: isCI,
  workers: isCI ? 1 : undefined,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: isCI
    ? [["list"], ["@argos-ci/playwright/reporter", { uploadToArgos: true }]]
    : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    // Chromatic's default capture width. No story declares its own viewport,
    // so every capture is taken here.
    viewport: { width: 1200, height: 800 },
    // The app, and therefore `.storybook/preview.tsx`, is dark first.
    colorScheme: "dark",
    // Subpixel antialiasing makes screenshots depend on the host; these flags
    // keep local and CI renders comparable.
    launchOptions: {
      args: ["--disable-lcd-text", "--font-render-hinting=none"]
    }
  },
  webServer: {
    // A static server that keeps the exact path: `serve` and friends turn
    // `/iframe.html` into a redirect, and Storybook then never boots.
    command: `python3 -m http.server ${PORT} --directory ${STATIC_DIR}`,
    url: `http://localhost:${PORT}/iframe.html`,
    reuseExistingServer: !isCI,
    timeout: 120_000
  }
});
