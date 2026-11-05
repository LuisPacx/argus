import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts", "apps/warroom/server/**/*.test.ts"],
    // Fails the run if a fake claude/gh/wrangler (or a grandchild of one) outlives it.
    globalSetup: ["packages/core/src/testing/no-leaked-fakes.ts"],
    // Local runs cap workers at 2 so concurrent agents don't saturate the machine.
    // CI keeps the default. See CODING_STANDARDS.md.
    maxWorkers: process.env.CI ? undefined : 2,
    // A Build test spawns a few dozen fake processes (git, the fake podman and the fake claude, gh and wrangler inside it) and must
    // pass under load from other projects on the machine (CODING_STANDARDS 14), so the 5 s default is too tight for all of them.
    testTimeout: 30_000,
  },
});
