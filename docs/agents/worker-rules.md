# Worker rules

Rules for agents that change this repo. Briefs point here.

- Change files only with the Edit and Write tools. Never patch files with python, sed, perl, or shell heredocs.
- One plain command per Bash call. No `&&`/`;` chains, no loops, no subshells.
- `git add` names each file. Never `git add -A` or `git add .`.
- If a safety check blocks a command, stop and report it. Never retry a variant.
- No writes to /tmp. Test temp files go through `packages/core/src/testing/temp.ts`; other scratch goes on the home disk.
- Kill processes by PID only, never by name pattern.
- Run the full suite once before committing, not after every edit. At most two full suites run on this machine at once.
- Signal tests target the node process (or its process group), never the pnpm wrapper, which does not forward signals.
- Your shell's cwd does not persist between calls; name the worktree in every command (`pnpm --dir <wt>`, `git -C <wt>`).
