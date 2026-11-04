# 06: argus-build-template repo
**Model:** sonnet / medium — new small repo with clear constraints from ADR 0003 and §4.

**What to build:** The template every Build is cloned from (ADR 0003): a minimal Cloudflare Workers web app that deploys to `<slug>.workers.dev`, with an `/implement-spec` skill that tells a headless `claude -p` to build the Spec as a narrow MVP, plus lint, CI and the disclosure footer (§10 invariant 4). It lives in its own repo at `~/code/argus-build-template`, not inside argus. Creating the GitHub repo is outward-facing: the worker builds and commits locally, and the Operator confirms before the repo is created and pushed.

**Blocked by:** None (can start immediately)

**Status:** built locally; awaiting Operator confirmation to create and push the GitHub repo

- [x] From a fresh clone: install, lint, typecheck and tests pass, and `wrangler deploy --dry-run` succeeds (TypeScript conventions as in argus)
- [x] Every page renders the disclosure footer stating the project was created by argus and the creator may sell; a script fails if the footer is missing, and the Build Runner can call that script
- [x] The `/implement-spec` skill (in the template's `.claude/skills/`) reads the Spec from a documented path, builds within the template, runs the checks and commits; it never deploys and never touches wallets, chains or keys
- [x] The skill emits a documented machine-readable needs-human marker when the Spec needs an on-chain program or anything not buildable as a Workers web app (consumed in ticket 09)
- [x] CI runs lint, typecheck and tests on push
- [x] No secrets in the repo; the README documents the env needed to deploy
- [ ] Pushed to a private GitHub repo under the personal owner, only after the Operator confirms
