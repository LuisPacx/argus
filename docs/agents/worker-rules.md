# Worker rules

Rules for agents that change this repo. Briefs point here.

- Change files only with the Edit and Write tools. Never patch files with python, sed, perl, or shell heredocs.
- One plain command per Bash call. No `&&`/`;` chains, no loops, no subshells.
- `git add` names each file. Never `git add -A` or `git add .`.
- If a safety check blocks a command, stop and report it. Never retry a variant.
- No writes to /tmp. Test temp files go through `packages/core/src/testing/temp.ts`; other scratch goes on the home disk.
- Kill processes by PID only, never by name pattern.
- While iterating, run `pnpm test:fast` (or `pnpm check:fast`) or just the test files you touch. The fast tier skips the slow tier (~1-2 min instead of ~9); it never stamps.
- Run the full `pnpm check` once before committing, not after every edit. At most two full suites run on this machine at once.
- A new test that spawns real processes (wrangler, podman, the worker, a real server) or takes over ~10 s goes in the slow tier: add its path to `SLOW_TESTS` in `vitest.tiers.mjs`. `scripts/test-tiers.test.ts` guards that every test file is in exactly one tier.
- Signal tests target the node process (or its process group), never the pnpm wrapper, which does not forward signals.
- Your shell's cwd does not persist between calls; name the worktree in every command (`pnpm --dir <wt>`, `git -C <wt>`).
- A PreToolUse hook (`.claude/hooks/bash-guard.sh`) enforces two of these rules: it denies in-place `sed -i` and `cd <dir>` chained with `&&` or `;`.
