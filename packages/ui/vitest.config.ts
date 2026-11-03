import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "jsdom", setupFiles: ["./test-setup.ts"], maxWorkers: 2, poolOptions: { forks: { execArgv: ["--no-experimental-webstorage"] } } },
  esbuild: { jsx: "automatic" },
});
