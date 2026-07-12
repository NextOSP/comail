import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pure-logic tests only (no DOM); UI behavior is covered by the
    // driven-scenario passes and the Rust e2e suites.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
