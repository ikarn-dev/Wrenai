import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { checkTestLayout } from "./scripts/check-tests.ts";

export default defineConfig(async () => {
  await checkTestLayout();
  return {
    resolve: {
      alias: {
        "@tests": fileURLToPath(new URL("./tests", import.meta.url)),
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    test: {
      include: ["tests/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs,cts,cjs}"],
      environment: "node",
      // Each PGlite worker owns a WASM database. Bound parallel instances instead of relaxing hook timeouts.
      maxWorkers: 2,
    },
  };
});
