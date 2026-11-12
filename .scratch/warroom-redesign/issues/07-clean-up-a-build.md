# 07: War Room: "Clean up build" removes a dead Build's Worker, GitHub repo and local directory
**Model:** sonnet / high — it deletes things outside argus (a Cloudflare Worker, a GitHub repo, a directory) and must be provably safe; the logic is small but the ownership checks, the idempotence and the "never a launched Proposal" rule need care and tests.

**What to build:** a Build leaves three artifacts outside argus: a Cloudflare Worker named by the slug (deployed with `wranglerEnv`, `packages/core/src/build-runner.ts:523`, `:832`), a private GitHub repo `<owner>/<slug>` (`gh repo create`, `:660`) and a checkout `~/code/<slug>` (`:644`, `:656`). Today removing a dead Build is manual: the Proposal page only tells the Operator to remove them before Re-queue (`apps/warroom/app/pages/proposals/[id].vue:184`), and Re-queue is refused while the directory or repo exists (`build-runner.ts:644`). Test Proposal 148 (2026-11-12) needed a worker doing a Cloudflare API DELETE, `gh repo delete` (failed: the gh token lacked the `delete_repo` scope), an `rm`, and a hand SQL delete. This ticket adds one War Room action that does the three deletions safely and records them.

**Status:** done except the browser check by cos after merge

**Blocked by:** none. See Interplay with 05 and hardening/06.

## Decided by cos (2026-11-12), the user can overrule

- **Who may be cleaned:** a Proposal whose status is `dismissed`, `closed`, or `build-failed`, and that has at least one artifact (a `~/code/<slug>` directory, a recorded repo, or `worker_deployed = 1`, `datastore.ts:316`). Never `launched` (a launched token's site must never be torn down), never `building`, `approved`, `built` (dismiss it first), `needs-human`. A `closed` Proposal that had been `launched` (`lifecycle.ts:56`, `launched -> closed`) is also refused: the check reads `status_history` for a `launched` row, not just the current status.
- **Action:** a "Clean up build" button on the Proposal page for the allowed statuses, beside the existing `build-failed` Re-queue note (`[id].vue:184`); it opens a confirm dialog listing exactly what will be deleted: the Worker name, `<owner>/<slug>`, and the directory path, each marked "found" or "not found" from a read-only dry run. Nothing is deleted until the Operator confirms. It is a command (`cleanup-build`) through the existing commands table and worker, like `requeue` (`[id].vue:88`, `lifecycle.ts:218-220`), not a War Room server action: the War Room holds no Cloudflare or GitHub credentials.
- **Ownership, so argus never deletes what it did not create** (each artifact is deleted only if its own check passes; a failed check leaves it and says why):
  - Worker: only when `worker_deployed = 1` (set when this Build's own `wrangler deploy` succeeded, `build-runner.ts:833-835`; `datastore.ts:1418,1425`) and the name is exactly the Proposal's slug.
  - Repo: argus must record `owner/slug` at `gh repo create` (new column, e.g. `build_repo`, by `ensureColumn` like `worker_deployed`; the tests use their own DB). Delete only that recorded repo, and only if the GitHub API still shows it private and with that exact name. A Proposal with no recorded repo (a Build from before this ticket) gets the repo deleted only if the directory's `origin` remote equals `<owner>/<slug>` and the Operator types the repo name in the dialog.
  - Directory: only `~/code/<slug>` with the slug validated (the same slug rule the Build uses), a real directory (not a symlink; `lstat`), under the build root, whose `origin` remote is that Proposal's repo. A directory with a different or no origin is not removed.
- **Order:** Worker, then repo, then directory (the directory last, because its origin remote is the ownership proof for a legacy repo). Each step is independent: one failing does not stop the others.
- **Result per artifact:** `deleted`, `already gone`, `skipped (not ours: <why>)` or `failed: <reason>`. A 404 from Cloudflare (error 10007, as in `requireFreeWorkerName`, `build-runner.ts:610-`) or from GitHub, or a missing directory, is `already gone`, so running it twice is safe (idempotent).
- **Failure shows the fix:** a GitHub 403/"must have admin rights"/missing scope answer shows the line to run: `gh auth refresh -h github.com -s delete_repo`, then "Clean up build" again. A Cloudflare auth failure names the two env keys (`CLOUDFLARE_API_TOKEN` needs Workers Scripts: Edit). No credential value ever appears in the result or the dialog.
- **Record:** one `status_history` row per artifact (actor `operator`, reason like `Clean up: Worker download-bar-blues deleted`), written by the worker; the Proposal's status does not change. A flag `build_cleaned` (see Open questions) is set only when all three artifacts are `deleted`, `already gone` or `skipped` with nothing left to remove.
- **Credentials:** the worker's `gh` call uses the same `GITHUB_ENV` pick as the Build (`build-runner.ts:69`), the Cloudflare call the same account and token (`:70`); neither enters the Build container (`sandbox.ts:395` builds its own env).

## Interplay

- **warroom-redesign/05** (show a blocked Build): 05 shows why an approved Proposal has not started. This ticket reuses its Proposal-page build line to show "Build artifacts: Worker / repo / directory" and the result of a clean-up; do not add a second status area. If 05 is not merged first, add the line here and let 05 extend it.
- **hardening/06** (run-time egress allowlist): the worker will then reach `api.cloudflare.com` (DELETE `/accounts/<id>/workers/scripts/<slug>`) and `api.github.com` (repo get and delete) from the argus process. Both hosts are declared in the egress module as fixed-host clients (class a, with env override for tests); neither is called from the War Room server. If hardening/06 lands first, this ticket adds the two entries; if this lands first, it calls them through the existing `fetch` injection (`o.fetch`, `build-runner.ts:600`) and hardening/06 inherits the two sites in its inventory. Running `gh` as a subprocess (as the Build does) is not covered by an in-process allowlist; use the GitHub REST API from the worker instead, so the host is declared.
- ADR 0002 is untouched: this deletes argus's own artifacts only; it never signs, trades or holds keys.

## Acceptance

- [x] The Proposal page shows "Clean up build" only for `dismissed`, `closed`, `build-failed` Proposals with at least one artifact, and never for a Proposal that was ever `launched` (tested for `launched`, and for `closed` after `launched`); the worker refuses a `cleanup-build` command for any other status (a `DomainError`, `lifecycle.ts:218-220` pattern).
- [x] The confirm dialog lists exactly the Worker name, `<owner>/<slug>` and the directory path from a read-only dry run, each marked found or not found; no command is created before the Operator confirms.
- [x] Confirming deletes the Worker (Cloudflare API DELETE), the repo (GitHub API) and the directory; verified in tests with injected `fetch` and a temp build root (`packages/core/src/testing/temp.ts`), not real services.
- [x] Ownership: a Worker is deleted only when `worker_deployed = 1`; a repo only when it is the recorded `owner/slug` (or the legacy rule above); a directory only when it is a real directory under the build root with the right `origin`. Tests: a symlink at `~/code/<slug>`, a directory with a foreign origin, a Worker with `worker_deployed = 0`, a slug with `..` or a slash, and a repo that is not private each leave the artifact in place and report `skipped (not ours)`.
- [x] Idempotent: a second run, with everything gone, reports `already gone` for all three and writes no error; a Cloudflare 404 with error 10007 and a GitHub 404 both count as gone.
- [x] Partial failure: with the GitHub step failing for a missing scope, the Worker and directory results are still `deleted`, the repo is `failed`, the page shows `gh auth refresh -h github.com -s delete_repo`, and re-running the action finishes the repo only. Because the directory is removed last, a failed repo step keeps the directory for the legacy ownership check.
- [x] Each artifact outcome is a `status_history` row; the Proposal status is unchanged; no credential value appears in any row, result, log line or the page (tested with a sentinel token).
- [x] After a full clean-up, Re-queue of a `build-failed` Proposal is no longer refused for the directory or the repo (`build-runner.ts:644`), and the War Room's remove-first note (`[id].vue:184`) is replaced by the button for those statuses.
- [x] No `v-html`; the dialog adds no external link; the buttons are disabled while a command is in flight.
- [x] Full `pnpm check` passes once on the committed clean tree.
- [ ] Browser check by cos after merge, on a throwaway built-then-dismissed Proposal: dialog contents, the three results, a second run, and the missing-scope message.

## Open questions

1. **Row after clean-up (cos default: keep, flag `build_cleaned`).** Keep the Proposal row with a `build_cleaned` flag shown on the page, or delete the row? Keeping preserves the dismissal feedback and `brain_runs`, and avoids a hand write to `.data/argus.db` (phase-3-feedback/17 keeps "no hand write to argus.db" as an open box after the Proposal 148 reset). A separate status `cleaned` would add a state to the glossary's Proposal status list and to `TRANSITIONS`; a flag does not. Alternative: a later "delete Proposal" command, its own ticket.
2. **Legacy Builds without a recorded repo (cos default: allowed with the typed-name confirmation).** Or refuse and require the Operator to delete the repo by hand?
3. **`built` Proposals:** the Operator must dismiss first (default). Or allow clean-up of an unlaunched `built` one directly?
4. **Cloudflare token scope:** the existing token ("Edit Cloudflare Workers") deletes Workers; confirm in the browser check, and if not, the failure message says which permission to add.

## Commits

One commit after the tests are green, subject `War Room ticket 07: <what changed>`, body ending with `Ticket: .scratch/warroom-redesign/issues/07-clean-up-a-build.md`. Boxes ticked in a follow-up docs commit if `pnpm check` stamps the clean tree. A GLOSSARY.md line only if Open question 1 picks a new status.

## Comments

Implemented (commit aae6488; `pnpm check` passed, stamped tree 54acba7604). Open questions took the cos defaults: row kept with `build_cleaned`, legacy Builds need the typed `owner/slug`, `built` is dismissed first. Decisions the ticket left open:

- The dialog's found / not found is argus's own records and a read-only look at the disk (the War Room holds no credentials, and no command may exist before confirming). Worker "found" = `worker_deployed = 1`; repo "found" = a recorded repo or one the checkout's origin names. Cloudflare and GitHub are asked by the worker on confirm; a 404 there is `already gone`.
- The repo is recorded from `gh repo create`'s output (`build_repo`); a Build whose output names no github.com repo called the slug records nothing and is treated as legacy.
- A checkout counts as a Build's only with a `template` remote as well as `origin` (the Build clones with `--origin template`), and its `.git/config` is read as text, not through git.
- Legacy repo: the origin owner must equal the token's own login (`GET /user`), because the agent can rewrite the origin. A legacy checkout is kept while its repo is still there (its origin is the only proof); a legacy repo that was deleted is then recorded so a second run says `already gone`.
- A Proposal that was ever launched (history row or mint) is refused at any status, including `dismissed`, which `launched` can reach.
- The GitHub token is `GH_TOKEN` / `GITHUB_TOKEN`, else `gh auth token`. Cloudflare DELETE does not use `force`.
- A Worker the Build did not deploy is `skipped (not ours)` but counts as nothing left to remove for `build_cleaned`; a symlink, foreign origin, non-private repo and renamed repo do not.
- Browser check by cos after merge is the one box not ticked.
