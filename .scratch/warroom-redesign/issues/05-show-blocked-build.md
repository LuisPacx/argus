# 05: An approved Proposal says why its Build has not started
**Model:** sonnet / medium — one small stored fact, one line on the Proposal page, one extension of a log line; all three are plain, the only care is that no secret reaches any of them.

**What to build:** when the Build Runner's preflight refuses to start a Build, the Operator sees it in the War Room, on the approved Proposal, instead of finding it in `worker.log`. Today the Proposal stays `approved` with no hint.

**Status:** done

**Blocked by:** none. Ticket 04 (on branch `meta-strip` when this was written) edits other War Room files; see Interplay.

## Problem (seen 2026-11-11, AC5 test on Proposal 148)

An approved Proposal stayed `approved` and the War Room showed nothing. The only trace was one line in `worker.log` (line 97265): `Build for proposal 148 not started: the Build token file ~/.config/argus/build-token does not exist ... retried on the next tick`. The fix for the cause was trivial; finding it was not.

## What is there today

- `apps/worker/src/main.ts:60` `TICK_MS = 5_000`; `main.ts:174` `buildTick` (guarded by `reentrant`) calls `runPendingBuilds(...)`; `main.ts:341` `runBuildTick`, fired at startup (402) and every `TICK_MS` (407).
- `packages/core/src/build-runner.ts:312` `nextBuildable` (oldest approval first, none while one is `building`); `:326` `runNextBuild`. Its order, which decides what can be shown:
  1. `:336` `if (o.dryRun) return dryRun(...)`: dry-run **logs the commands and starts nothing** (see `dryRun` at `:451`); it returns before the preflight, so a dry-run worker leaves every approved Proposal `approved` and says so only in the log.
  2. `:338-342` a Spec that is the `## Needs human` refusal moves the Proposal to `needs-human` at once (visible already as a status; not a refusal for this ticket).
  3. `:346` `const refusal = await o.sandbox.preflight()`; a string means refused. `:347-351` logs it once per change (`lastRefusal`, a `WeakMap` at `:308`, so one line, not one per tick) and returns `undefined`. `:353` clears `lastRefusal`; `:356` `store.beginBuild` starts the Build.
- `packages/core/src/sandbox.ts:425` `PodmanSandbox.preflight()` returns the first failing of, in this order:
  1. podman not runnable: `podman --version` fails (`:426-427`; names `ARGUS_PODMAN_BIN`).
  2. the Build image is not present (`:428`, `imageReady`; names the tag and `pnpm image:build`).
  3. the podman network `BUILD_NETWORK.name` does not exist (`:429-430`).
  4. the Build token file (`:431-435`, `readBuildToken` at `sandbox.ts:313`): does not exist; not a file; readable by others (mode `& 0o077`); empty; more than one line. Its messages carry the path and never the token (tested at `sandbox.test.ts:212`).
- **Gap, found 2026-11-11 (cos, same Proposal 148):** after the token file was added, Proposal 148 went to `build-failed` ("The Build failed after its retry"); the build log said "Build failed: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are needed to check that the Worker name is free". The Cloudflare credentials are **not** in the preflight. They are read from `o.env ?? process.env` (`build-runner.ts:518`; the names are `CLOUDFLARE_ENV` at `:70`) and first checked inside a started Build by `requireFreeWorkerName` (`build-runner.ts:596-599`, called at `:654` and `:831`): the Build takes the slot, clones, burns its retry, ends `build-failed`, and the Operator must Re-queue. A missing credential is a worker-wide condition known before any run is spent, so it belongs in the preflight (Slice 1), where the Proposal stays `approved` with a visible reason.
- Other things a Build needs that fail only after it started (`StepError`s in `build-runner.ts`; none are checked up front today): `git` and `gh` runnable and `gh` logged in (`ARGUS_GIT_BIN`, `ARGUS_GH_BIN`, `main.ts:125-126`), `wrangler` (`ARGUS_WRANGLER_BIN`, `main.ts:127`), the template checkout on a branch (`:659`). The implementer lists every `StepError` and external precondition in `build-runner.ts` that depends only on the environment (not on the Proposal or the network at that moment), and moves each into the preflight if it can be checked cheaply and without spending a run; those that need the network (the Worker-name-free lookup itself, `:600-618`) stay in the Build. The Cloudflare presence check is mandatory; the others are judged and listed in the ticket's Comments.
- `packages/core/src/lifecycle.ts:54` is the `approved -> building` transition (actor `build`, "Build started"); `:56` `building -> needs-human`.
- Env: `ARGUS_DRY_RUN` and `--dry-run` (`main.ts:64`), `ARGUS_BUILD_IMAGE` (`main.ts:100`, default `currentImageTag(repoRoot)`), `ARGUS_BUILD_TOKEN_FILE` (`main.ts:102`, default `~/.config/argus/build-token`).
- `packages/core/src/startup-config.ts:32` `startupConfigLine(env, facts)` builds the `[config]` line; `StartupFacts` (`:11`) is booleans only "so no secret can reach the line". It has no build field. It is called from `main.ts` (the `console.log(startupConfigLine(process.env, {...}))` line just before `const running`).
- `apps/warroom/app/pages/proposals/[id].vue:220` shows `Approved <time>` for an approved Proposal and nothing about the Build.

## Slices

### 1. Store the latest refusal

Per Proposal: a **reason code**, the **human message**, and the **time** (UTC ISO, the repo's usual timestamp), kept on the Proposal's row or in a small table keyed by Proposal id (the implementer picks one, via the repo's migration route). One value per Proposal: a newer refusal replaces the older.

- `PodmanSandbox.preflight()` keeps returning a string for existing callers, but a typed refusal `{ code, message }` is added beside it (or replaces it, with `runNextBuild` adapted) so the code is not parsed out of English. Codes, one per check above: `podman-missing`, `image-missing`, `network-missing`, `token-missing`, `token-not-file`, `token-mode`, `token-empty`, `token-multiline`.
- `runNextBuild` writes the refusal for the Proposal it was about to build (`nextBuildable`) on **every** refusal tick, not only when the log line changes (`lastRefusal` stays as the log de-dupe), so the stored time is the latest attempt. Writing the same code and message every 5 s must not grow history: it is an upsert of one value, not an event row.
- It is cleared in the same transaction that starts the Build (`store.beginBuild`), and when the Proposal leaves `approved` by any route (dismissed, `needs-human`, re-queued Build gets a fresh slate). A Proposal that is not `approved` has no stored refusal.
- **No secrets.** The message is exactly what `preflight()` produces today: it may contain the token file **path**, the image tag and the podman binary name, and never the token or any byte of the file. A test asserts this by writing a recognizable secret into the token file, forcing each token refusal, and grepping the stored value, the API payload and the log output for the secret.
- **Cloudflare credentials join the preflight.** After the token check, `preflight` also refuses when `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN` is unset or empty in the environment the Build would use (the same `o.env ?? process.env` that `build-runner.ts:518` reads, so preflight and Build cannot disagree; share one helper). Codes `cloudflare-account-missing` and `cloudflare-token-missing`, or one `cloudflare-creds-missing` naming which variable(s); the message names the variable **names** only, never a value. Because `PodmanSandbox` knows nothing of Cloudflare, the check sits in `runNextBuild` beside `o.sandbox.preflight()` (or the preflight becomes a runner-level function that calls the sandbox's), the implementer's choice. The in-Build check at `:596-599` stays as a backstop. Any further environment-only preconditions found by the survey in "What is there today" are added the same way, each with its own code and test.
- `ARGUS_DRY_RUN`: the dry-run branch returns before the preflight, so it stores no refusal. Decide in this slice and test it (see Open question 1).

### 2. The Proposal page

For a Proposal with status `approved`, in the place of / beside the "Approved <time>" note (`proposals/[id].vue:220`):

- with a stored refusal: **"Build not started: <message>, retried every N s"**, N from one shared constant equal to the worker's build tick (`TICK_MS / 1000` = 5; export it from `@argus/core` rather than copying the number into the page), plus when it was last checked ("last checked 12 s ago", from the stored time).
- without one: **"Waiting for the next build tick"** (the Proposal is queued, or behind a Build that is running; when another Proposal is `building`, say "Waiting for the running Build to finish" instead, using the data the page already has or one cheap query).
- not shown for any other status.

Rendered as text only (`{{ }}`, never `v-html`): the message contains a filesystem path. The API response for the Proposal carries `{ code, message, at }` or `null`; it has no field that could hold a secret.

### 3. The `[config]` line

`startupConfigLine` gains build fields, as booleans and short tags only:

- `build_dry_run=on|off` (the effective value: `--dry-run` or `ARGUS_DRY_RUN=1`),
- `build_image=<tag>` (the tag, not the image id; a tag is not a secret),
- `build_cloudflare=yes|no` (both `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` set and non-empty; presence only, never a value, never a prefix or length),
- `build_token=present|absent` (the file exists and is a file; **never** its content, never its path in this field; the `readable by others` / `empty` cases are what slice 1 reports, this field is the quick "is there a file at all").

`StartupFacts` grows four fields (`buildDryRun: boolean`, `buildImage: string`, `buildCloudflare: boolean`, `buildTokenPresent: boolean`) computed in `main.ts` from the values it already holds (`dryRun`, the `PodmanSandbox` image, `existsSync` of the token path). The function stays pure over `env` and `facts`; the existing test of the line is extended, not replaced.

## Acceptance

- [x] **Regression for Proposal 148:** with the Build token file valid and `CLOUDFLARE_ACCOUNT_ID` and/or `CLOUDFLARE_API_TOKEN` unset (each alone, and both), `runNextBuild` starts no Build: the Proposal stays `approved`, no slot is taken, no clone happens, no retry is spent, nothing reaches `build-failed`, and the stored refusal names the missing variable name(s) and no value. With both set, the preflight passes. The in-Build backstop at `requireFreeWorkerName` still fails a Build whose env lost them mid-run.
- [x] Each preflight refusal code (the eight above plus the Cloudflare one(s) and any added by the survey) is produced by a test that sets up that exact condition (fake podman via the existing `ARGUS_PODMAN_BIN`/`passEnv` fakes in `sandbox.test.ts` for the first three; a temp token file made through `packages/core/src/testing/temp.ts` for the five token cases) and asserts the typed `{ code, message }`.
- [x] After `runNextBuild` is refused, the Proposal has a stored refusal with that code, message and a time; a second refused tick with the same refusal updates only the time (one value, no growth); a different refusal replaces the first.
- [x] The stored refusal is cleared when the Build starts (`beginBuild`), and when the Proposal is dismissed, routed to `needs-human`, or otherwise leaves `approved`; a Proposal that is not `approved` never reports one (store-level tests).
- [x] Secret test: with a recognizable secret as the token file's content, no stored refusal, API payload, rendered page or captured log line contains it, for every token refusal (`token-mode`, `token-empty`, `token-multiline` read the file; this is the case that matters).
- [x] The Proposal API returns the refusal as `{ code, message, at }` or `null`; the type is shared so a renamed field is a type error.
- [x] Proposal page render test (compile and server-render the real template, as `current-meta.test.ts` does): approved with a refusal shows "Build not started: <message>, retried every 5 s" and the last-checked age; approved without one shows "Waiting for the next build tick"; approved while another Proposal is `building` shows the running-Build wording; any other status shows none of the three. A message holding markup and a `javascript:` URL renders as text.
- [x] The retry interval in the text comes from the exported constant the worker's `setInterval` also uses (one definition; a test fails if they diverge).
- [x] `startupConfigLine` includes `build_dry_run`, `build_image`, `build_cloudflare` and `build_token` in the right states (dry-run via flag and via env; image from `ARGUS_BUILD_IMAGE` and from the default; Cloudflare yes only when both variables are non-empty; token file present, absent, a directory); a test with a secret token file content and secret Cloudflare values asserts the line contains neither, and that `build_token` is only `present` or `absent` and `build_cloudflare` only `yes` or `no`.
- [x] Dry-run behaviour is decided and tested as per Open question 1.
- [x] Full `pnpm check` passes once before the commit.
- [x] **Browser check:** with a worktree War Room on a `.backup` copy of the DB, an approved Proposal and no token file, the Proposal page shows the "Build not started" line; after creating the token file (chmod 600) and a tick, the line is gone. Stop the server by PID and delete the DB copy afterwards. Cite it in Comments.

## Interplay

- **Ticket 04** (`meta-strip`, in progress) edits War Room files; this ticket's page change is confined to `proposals/[id].vue` near line 220, plus the Proposal API row. If 04 touches the same page, whichever lands second rebases.
- **Live run:** a 48 h run uses the main checkout and `.data/argus.db`. Work in a worktree; never run the worker or migrations against the live DB; schema changes ship with the next restart, which the chief of staff does.
- **Glossary:** Build (the project), Build container, Operator, Proposal. Say "Build token" and "Build image" as the code does; do not call the container a sandbox in War Room text.
- **Logs:** the `[worker] Build for proposal N not started: ...` line stays as is (it is the greppable trace); this ticket adds the War Room view and the config fields, it removes nothing.

## Open questions for the Operator

1. **Dry run.** A dry-run worker never starts a Build and never reaches the preflight. Should the Proposal page then say "Build not started: the worker is in dry-run mode, retried every 5 s" (needs a stored refusal with code `dry-run`, written by `runNextBuild` before it returns), or stay silent (dry run is a test mode)? The brief for this ticket lists dry-run among the refusals; the code does not treat it as one. Default if unanswered: store `dry-run`, since the same "approved and nothing happens" symptom is what the ticket is about.
2. **Refusals for the Proposal behind the queue.** Only the Proposal `nextBuildable` picks (oldest approved) gets a stored refusal; later approved Proposals read "Waiting for the next build tick" although they are blocked by the same cause. Show the same refusal on all approved Proposals (it is a worker-wide condition)?
3. **Alert beyond the page.** Should a refusal older than some time (for example 10 min) also go to Telegram once? Not in this ticket unless asked.

## Commits

One commit, after a full `pnpm check`. Subject `War Room ticket 05: <what changed>`, body ending with `Ticket: .scratch/warroom-redesign/issues/05-show-blocked-build.md` before the trailers. Tick the boxes in the commit only if the full check does not stamp the tree afterwards, otherwise in a follow-up docs commit. No `Closes #N`: this repo has no GitHub issues.

## Comments

- 2026-11-11 (cf-env fix): the worker now loads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN from the environment or the git-ignored .env (`cloudflareEnv` in `packages/core/src/telegram.ts`, same rules as `telegramEnv`) and passes them in `buildOptions.env` (`apps/worker/src/main.ts`). The preflight check and `build_cloudflare` must read that same `buildOptions.env`, not `process.env`. `build_cloudflare` is NOT added to the `[config]` line yet: the line has no build fields until slice 3 here.
- 2026-11-11 (implementation): Operator decisions applied: the dry-run refusal is stored (code `dry-run`); the refusal is stored for and shown on every approved Proposal (one row each, all replaced on each refused tick, all cleared when any Build starts); no Telegram message. Storage: table `build_refusals` (proposal_id, code, message, at), dropped in `transition` on any status change and in `beginBuild`; `buildRefusalFor` returns null unless the Proposal is `approved`. The API adds `buildRefusal`, `buildRunning`, `buildRetrySeconds` (type `ProposalBuildStatus`); the page reads the tick from the API, which takes `BUILD_TICK_MS` from core, the same constant the worker's `TICK_MS` is defined as. Secret test covers the stored value (which is the API payload and all the page renders) and the log lines; the page-level message rendering is tested with hostile text.
- Survey of other environment-only preconditions (git, gh and its login, wrangler, template checkout on a branch): not moved into the preflight. Each is either only checkable by running the tool against the network or the Proposal (`gh` login, the template branch), or fails at once and clearly in the first steps of the Build with a retryable StepError; only the Cloudflare presence check was mandatory and is in. A later ticket can add `git --version`/`gh auth status` if they bite.
- Browser check (last box) not run: it needs a worktree War Room on a `.backup` DB copy and a live token file; left for the chief of staff. Schema change (new table) ships with the next worker restart.
- 2026-11-12 (review fixes): a token file the worker cannot read (mode 0200/0000, EACCES) is now the refusal `token-unreadable` (path only, no system error text) instead of a rejected tick; the secret test also covers token-missing, token-not-file and token-unreadable.
- 2026-11-12 browser check (cos, Chrome) on a worktree War Room :3101 + worker on a .backup copy, Proposal 152 approved, token path via ARGUS_BUILD_TOKEN_FILE, no CF/Telegram/Anthropic env, podman/gh/wrangler faked: page showed token-missing line; after creating the token (chmod 600) the line switched live to cloudflare-creds-missing and no Build started. Adapted from 'line is gone' with the user's OK (a real Build would deploy); clearing on Build start is covered by unit tests. Copy, token and worktree removed.
