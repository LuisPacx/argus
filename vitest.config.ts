import { configDefaults, defineConfig } from "vitest/config";
import { fastTier, INCLUDE, SLOW_TESTS } from "./vitest.tiers.mjs";

export default defineConfig({
  test: {
    include: INCLUDE,
    // ARGUS_TEST_TIER=fast (pnpm test:fast) leaves out the slow tier listed in vitest.tiers.mjs.
    exclude: fastTier() ? [...configDefaults.exclude, ...SLOW_TESTS] : configDefaults.exclude,
    // Fails the run if a fake claude/gh/wrangler (or a grandchild of one) outlives it.
    globalSetup: ["packages/core/src/testing/no-leaked-fakes.ts"],
    // Local runs cap workers at 2 so concurrent agents don't saturate the machine.
    // CI keeps the default. See CODING_STANDARDS.md.
    maxWorkers: process.env.CI ? undefined : 2,
  },
});
