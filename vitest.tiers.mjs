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
  "packages/core/src/build-image.test.ts", // real `podman run` against the built image (self-skips when absent, but belongs here)
  "packages/core/src/egress-proxy-entry.test.ts", // spawns the real proxy entry as a child process
  "packages/core/src/build-refusal.test.ts", // fake podman
  "packages/core/src/build-runner-bundle.test.ts", // fake wrangler, whole Builds
  "packages/core/src/build-runner-bundle-outdir.test.ts", // fake wrangler, whole Builds
  "packages/core/src/build-runner-bundle-real.test.ts", // real wrangler --dry-run
  "packages/core/src/build-runner-bundle-real-txt-html.test.ts", // real wrangler --dry-run
  "packages/core/src/build-runner-bundle-real-bin-wasm.test.ts", // real wrangler --dry-run
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

// Only the exact value "fast" selects the fast tier; anything else (unset, "full", junk) is the full suite.
export const fastTier = (env = process.env) => env.ARGUS_TEST_TIER === "fast";

// The env `pnpm check` hands its steps: the tier is always set explicitly, so an ambient ARGUS_TEST_TIER=fast
// in the caller's shell can never turn a stamping full check into a fast-only one.
export const checkEnv = (fast, env = process.env) => ({ ...env, ARGUS_TEST_TIER: fast ? "fast" : "full" });
