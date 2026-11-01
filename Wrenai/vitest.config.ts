import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Each PGlite worker owns a WASM database. Bound parallel instances instead of relaxing hook timeouts.
    maxWorkers: 2,
  },
});
