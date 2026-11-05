import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts", "apps/warroom/server/**/*.test.ts", "scripts/*.test.ts"],
    // Fails the run if a fake claude/gh/wrangler (or a grandchild of one) outlives it.
    globalSetup: ["packages/core/src/testing/no-leaked-fakes.ts"],
    // Local runs cap workers at 2 so concurrent agents don't saturate the machine.
    // CI keeps the default. See CODING_STANDARDS.md.
    maxWorkers: process.env.CI ? undefined : 2,
  },
});
