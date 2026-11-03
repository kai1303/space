import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "jsdom", setupFiles: ["./test-setup.ts"], maxWorkers: 2 },
  esbuild: { jsx: "automatic" },
});
