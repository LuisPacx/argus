import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    // Local runs cap workers at 2 so concurrent agents don't saturate the machine.
    // CI keeps the default. See CODING_STANDARDS.md.
    maxWorkers: process.env.CI ? undefined : 2,
  },
});
