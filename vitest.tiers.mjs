// Test tiers. `pnpm test` runs everything; `pnpm test:fast` (ARGUS_TEST_TIER=fast) skips SLOW_TESTS.
// SLOW_TESTS is the single list: files that start real external processes (wrangler, podman, a spawned worker)
// or that take over ~10 s. Everything not listed is fast. scripts/test-tiers.test.ts guards the partition.
export const INCLUDE = ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts", "apps/warroom/server/**/*.test.ts", "scripts/*.test.ts"];

export const SLOW_TESTS = [
  "apps/worker/src/api-fallback.test.ts", // spawned worker
  "apps/worker/src/boot.test.ts", // spawned worker
  "apps/worker/src/ingest.test.ts", // spawned worker
  "apps/worker/src/telegram.test.ts", // spawned worker
  "packages/core/src/brain.test.ts", // >10 s
  "packages/core/src/build-runner-bundle.test.ts", // real wrangler --dry-run
  "packages/core/src/build-runner-hardening.test.ts",
  "packages/core/src/build-runner-notify.test.ts",
  "packages/core/src/build-runner-retry.test.ts",
  "packages/core/src/build-runner-verify.test.ts", // spawns processes
  "packages/core/src/build-runner.test.ts",
  "packages/core/src/judge-pass.test.ts",
  "packages/core/src/propose-pass.test.ts",
  "packages/core/src/sandbox-lifecycle.test.ts", // podman
  "packages/core/src/sandbox-teardown.test.ts", // podman
  "packages/core/src/sandbox.test.ts", // podman
];

export const fastTier = () => process.env.ARGUS_TEST_TIER === "fast";
