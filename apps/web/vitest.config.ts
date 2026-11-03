import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "jsdom", setupFiles: ["../../packages/ui/test-setup.ts"], maxWorkers: 2, testTimeout: 15_000 },
  esbuild: { jsx: "automatic" },
});
