# Argus architecture and plan

Terms (Signal, Source, Narrative, Tech, Proposal, Spec, Build, Launch, Operator, Team, War Room, Dismissal, Proposal status, Study, Snapshot, Case, Cohort, Playbook, Organic migration, Fast migration) are defined in [`GLOSSARY.md`](../GLOSSARY.md). Decisions are recorded in [`docs/adr/`](adr/) and the journal [`.scratch/cos.md`](../.scratch/cos.md).

## 1. Purpose and the human-in-the-loop principle

Argus watches public Sources, clusters Signals into Narratives, and proposes tokens whose Tech (a new product that rides the Narrative) argus can then build. It researches, proposes and builds; it never launches. The Operator decides at every gate: shortlist, approve the Spec, dismiss, and finally Launch. The Launch happens manually in newpairspam (token deploy, trading and PnL live there). The Team is only notified (Telegram) and discusses outside the system.

Principle: every spend or irreversible step passes through one Operator decision, implemented as a single function (`approve(proposalId)`), so a score threshold can replace the click later without touching the rest. That replacement is phase 3b only: `approve()` with actor `system` is reachable only behind an off-by-default config switch with a daily cap, and only after the 3b gate (section 12).

## 2. System overview

<!-- generated:pipeline-overview -->
<!-- Generated from packages/core/src/pipeline-graph.ts and lifecycle.ts by `pnpm docs:graph`. Do not edit by hand. -->

```mermaid
flowchart TD
  SOURCES["Sources<br/>market: PumpPortal, DexScreener<br/>context only: RSS catalog, Google Trends, GitHub trending<br/>plain code, no Claude<br/>Polled every: 5 min"]
  SIGNALS[("Signals")]
  NARRATIVES["Narratives<br/>clustering, plain code, no Claude"]
  JUDGE["Judge<br/>Runs every: 30 min"]
  PROPOSALS[("Proposals<br/>New Proposals per day: 30")]
  SHORTLIST["Shortlist"]
  SPEC["Spec<br/>drafted on shortlist"]
  APPROVE["Approve"]
  BUILD["Build<br/>Build Runner, one Build at a time"]
  PREVIEW["Preview"]
  STUDY["Study<br/>plain code, no Claude: PumpPortal create and migrate, Snapshots, chain labels"]
  META["Meta<br/>Ranked every: 15 min"]
  MEME["Meme ideas<br/>New Meta, then every 12 h, one sonnet run, 3 ideas<br/>A Meta gets ideas again every: 12 h<br/>Runs per day: 24<br/>(off)"]
  OPERATOR{{"Operator"}}
  WARROOM["War Room (localhost)"]
  TELEGRAM["Telegram, notify only"]
  HANDOFF["Launch handoff: newpairspam form prefilled"]
  MARKED["Operator marks launched + mint"]
  PLAYBOOK[("Playbook: lessons and Rubric changes")]
  REVIEW["War Room: Study page and weekly Playbook review"]

  SOURCES -->|"poll, normalise, dedupe"| SIGNALS
  SIGNALS -->|"cluster by meaning"| NARRATIVES
  NARRATIVES -->|"judge new or changed Narratives<br/>Needs a market Signal from: pumpportal:events, dexscreener:trending"| JUDGE
  JUDGE -->|"Score passes the buildability gate<br/>Buildability gate, minimum (default 5)"| PROPOSALS
  JUDGE -->|"news story fails the buildability gate, passes the floors<br/>Legitimacy, minimum: 5<br/>Hook, minimum: 6<br/>Momentum, minimum: 6"| MEME
  PROPOSALS -->|"Operator shortlists"| SHORTLIST
  SHORTLIST -->|"Spec drafted on shortlist"| SPEC
  SPEC -->|"Operator edits and approves"| APPROVE
  APPROVE -->|"queued, one Build at a time"| BUILD
  BUILD -->|"wrangler deploy to workers.dev"| PREVIEW
  SOURCES -->|"PumpPortal create and migrate"| STUDY
  SOURCES -->|"launchpad creates"| META
  SOURCES -->|"Jupiter trending (market cap, liquidity, volume)"| META
  SOURCES -->|"GeckoTerminal trending (3 pages)"| META
  SOURCES -->|"leaders' market caps verified on DexScreener"| META
  SIGNALS -->|"matching news: context only, never a trigger"| META
  META -->|"New Meta"| WARROOM
  META -->|"Meta block in the prompt"| JUDGE
  META -->|"Meta block in the prompt"| PROPOSALS
  META -->|"new Meta, then every 12 h while it is copied, cap 24 a day, room-left as a reason"| MEME
  MEME -->|"3 meme Proposals per run"| PROPOSALS
  PROPOSALS -->|"list"| WARROOM
  PROPOSALS -->|"notify"| TELEGRAM
  WARROOM -->|"reads"| OPERATOR
  OPERATOR -.->|"shortlist"| SHORTLIST
  OPERATOR -.->|"approve"| APPROVE
  PREVIEW -->|"preview link"| WARROOM
  WARROOM -->|"Launch button"| HANDOFF
  HANDOFF -.->|"launches outside argus"| OPERATOR
  OPERATOR -->|"after the launch"| MARKED
  MARKED -->|"status launched"| PROPOSALS
  MARKED -->|"mint read-only at 1h, 24h, 7d"| STUDY
  STUDY -->|"lesson candidates"| PLAYBOOK
  PLAYBOOK -->|"weekly review"| REVIEW
  REVIEW -->|"reads"| OPERATOR
  OPERATOR -.->|"approves lessons"| PLAYBOOK
  PLAYBOOK -->|"approved lessons, versioned"| JUDGE
  PLAYBOOK -->|"approved lessons, versioned"| PROPOSALS
```

<!-- /generated:pipeline-overview -->

Notes:

- Ingestion is plain code (fetch, normalize, dedupe, embed, cluster). No LLM runs there.
- The brain pass only looks at the delta since the last pass (new or materially changed Narratives) and is capped at 30 new Proposals per day.
- The Spec is drafted when the Operator shortlists (not at Proposal creation), and the Operator edits it in the War Room before approving.
- Launch itself is outside argus: the handoff only opens newpairspam with the form prefilled; the Operator launches there and returns to mark it.
- The Study (phase 3a) is a second pipeline beside the brain pass. It learns which of Narrative, Identity and Tech go with Organic migration on pump.fun, and it never creates Proposals. Stages, all plain code except the study runs:
  1. Create and migrate events from the existing PumpPortal connection (one WebSocket only; `uri` and raw event fields are kept), with event times and labels read from chain (Helius, read-only).
  2. A Snapshot of each token in the population (metadata names a website or X link), frozen at a fixed age: metadata and website at 60 s after create (plain fetch, SSRF guard), X at 5 min (window 5 to 15 min) by a Playwright script in the dedicated logged-in Chrome directory (ADR 0009), about 200 captures per day. No Claude in the capture path.
  3. A chain labeller at 24h (provisional) and 7d (final). The 7d label makes a Case (Snapshot plus outcome bucket); Cases group into weekly Cohorts. Buckets are control, organic migrator and bot-driven migrator (five-check bot filter on raw stored metrics, from our own Helius-based labeller), plus the Fast flag: migrated within 60 s of creation, measured by slice 1 (`.scratch/phase-3-feedback/measurements.md`).
  4. Blind study runs (planned, not built: `BrainTask` has no `study` today, so the Study spends no Claude, see section 5): a `study` Brain task would read one Snapshot as untrusted data, never the label; aggregation into lesson candidates is plain code.
  5. The Playbook (lessons and suggested Rubric changes) is reviewed weekly by the Operator in the War Room. Approved lessons are rendered into the judge and propose prompts at call time, with the Playbook version (section 7).
- The Operator's own Launches are read from chain after "mark launched" and tracked as outcomes only, kept out of Cohort statistics.
- **Proposal kinds (ADR 0013).** A Proposal has a kind, `proposals.kind`: `narrative` (the path above; old rows read `narrative`) or `meme`. A `meme` Proposal is a token idea for a live Meta, generated from the Meta (missed-ideas/06), or, as its one other source, for a news story: a `news` Narrative that failed the buildability gate and passes the floors (legitimacy 5, hook 6, momentum 6, its newest Signal under 12 h old, at least one news Signal, no meme trio for it ever; proposal-routing/04, ADR 0013 amendment). A news meme stores `meta_key = narrative:<id>`, sets `narrative_id` and `score_id`, and carries a version 3 snapshot (the story, the Score it failed with, its news); it does not block a later Tech Proposal for the Narrative (`proposals_narrative_id` is unique over `kind = 'narrative'` rows only), and it is not counted in the 30-a-day research cap, only in the meme cap of 24 runs a day (Metas are served first; a story that names a current Meta or Watching subject is left to it). A `meme` Proposal replaces the `beta` kind that was never wired (the room-left ranking of `packages/core/src/beta/` is an input to its prompt, not a gate). It stores the Meta label and an immutable Meta snapshot, and carries a name, ticker, angle, how it differs from the leader, a short description, an X first-post hook, an image idea as text, risk labels and evidence links. Generation (amended 2026-11-15, meta-redesign ticket 03) is when a subject becomes a Meta and again every 12 h while it stays one (a new Meta first, then the oldest refresh), never a second trio inside 6 h, 3 ideas in one sonnet run, at most 24 runs a day from the research budget (meta redesign ticket 17: a refresh is skipped when the Meta had fewer than 10 creates in the last 6 h; a New Meta is never skipped by that). Lifecycle: Shortlist, Dismiss with a reason, and Why; no Spec, no Build and no Rubric score of its own (no buildability gate); it expires after 12 h in `new` unless shortlisted (a shortlisted one keeps the 7 days). It shows as a list filter on Proposals and under each Meta on `/meta`. Its legitimacy rule is Rubric v3 (missed-ideas/04; not yet in section 7), read from the stored Rubric into the prompt. The "Meme ideas" node in the generated overview above is the task (section 5, `meme-ideas`), off until `ARGUS_MEME_IDEAS=1`; it replaces the old "Beta finder" node. argus still launches nothing (ADR 0002).

## 3. Proposal lifecycle

<!-- generated:pipeline-lifecycle -->
<!-- Generated from packages/core/src/pipeline-graph.ts and lifecycle.ts by `pnpm docs:graph`. Do not edit by hand. -->

```mermaid
stateDiagram-v2
  state "spec-drafted" as spec_drafted
  state "build-failed" as build_failed
  state "needs-human" as needs_human

  [*] --> new
  new --> shortlisted : Operator shortlisted (operator)
  shortlisted --> spec_drafted : Spec drafted (system)
  shortlisted --> new : Operator undid the shortlist (operator)
  spec_drafted --> new : Operator undid the shortlist (operator)
  spec_drafted --> approved : Operator approved (operator)
  spec_drafted --> approved : Score threshold (system)
  approved --> building : Build started (build)
  approved --> needs_human : Spec needs an on-chain program (build)
  building --> built : Deploy ok (build)
  building --> build_failed : Build failed after retry (build)
  build_failed --> approved : Operator re-queued (operator)
  building --> needs_human : Spec needs an on-chain program (build)
  built --> launched : Operator marked launched (operator)
  launched --> closed : Closed after Launch (operator)
  new --> closed : stale (system)
  shortlisted --> closed : stale (system)
  new --> dismissed : Dismissed (operator)
  shortlisted --> dismissed : Dismissed (operator)
  spec_drafted --> dismissed : Dismissed (operator)
  approved --> dismissed : Dismissed (operator)
  building --> dismissed : Dismissed (operator)
  built --> dismissed : Dismissed (operator)
  launched --> dismissed : Dismissed (operator)
  build_failed --> dismissed : Dismissed (operator)
  needs_human --> dismissed : Dismissed (operator)
  dismissed --> [*]
  closed --> [*]
```

<!-- /generated:pipeline-lifecycle -->

| Transition | Triggered by | Notes |
|---|---|---|
| new | system | Brain pass creates the Proposal and notifies Telegram. |
| new -> closed (stale) | system | 48 h without action (12 h for a `meme` Proposal, ADR 0013). Stored as `closed` with reason `stale`. |
| shortlisted -> closed (stale) | system | 7 d without action. |
| new -> shortlisted | Operator | Starts Spec drafting. The War Room asks for confirmation first (a modal: it starts one paid Sonnet run). |
| shortlisted -> spec-drafted | system | After the Operator shortlists, the brain `spec` task writes `spec.md`; Operator edits freely. |
| shortlisted/spec-drafted -> new | Operator (`undo-shortlist` command) | "Undo shortlist": available until the Spec is approved. Not a dismissal: no reason, no research feedback. See the note below. |
| spec-drafted -> approved | Operator (via `approve()`) | One function. |
| spec-drafted -> approved | system (via `approve(store, id, "system")`) | Phase 3b only: score threshold behind an off-by-default switch with a daily cap, recorded with reason "Score threshold". Same function, different actor. |
| approved -> building | Build step | Dequeued FIFO by approval time, one Build at a time. |
| approved/building -> needs-human | Build step | Spec requires an on-chain program or anything not buildable unattended as a Cloudflare Workers web app (ADR 0003). |
| building -> built | Build step | After `wrangler deploy` succeeds and the preview URL responds. |
| building -> build-failed | Build step | After the one automatic retry. Stores `session_id`. |
| build-failed -> approved | Operator (`requeue` command) | Back into the Build queue; see the note below. |
| built -> launched | Operator | "Mark launched" with the mint recorded. |
| launched -> closed | Operator today (`lifecycle.ts`); planned for the system in phase 3a | Today the Operator closes a launched Proposal. Planned phase 3a automation: at the 7d label of the Proposal's mint argus closes it itself with the own-launch outcome fields (curve completed, migration, DexScreener market data at 1h, 24h and 7d), read-only from chain, replacing the manual step; manual outcome entry would be dropped. |
| any non-closed state -> dismissed | Operator | Reachable from every state except `closed`. Dismissal with a reason; from phase 3 the reasons are shown in their own section of the weekly Playbook review, beside the lessons. They are not Study evidence and are not approved into prompts by themselves. |

Notes on gaps the journal leaves to implementation: `spec-drafted` has no auto-expiry (only `new` and `shortlisted` expire); `launched -> closed` is made by the Operator today (the transition table's actor); the planned phase 3a automation would make it the system's, at the 7d label. Expiry (ticket 10) runs on the worker tick, counts from the Proposal's latest transition into its current status (`status_history.at`; a later write such as a Spec edit does not extend it; `new` counts from creation instead, see Undo shortlist below), skips a Proposal with a Brain run in flight (it closes on a later tick), and the card shows the time left.

Undo shortlist (ticket 20): the Operator can take a shortlist back from `shortlisted` or `spec-drafted`. The worker applies the command in one write transaction (`Datastore.undoShortlist`): the status goes back to `new` (history: `shortlisted -> new` or `spec-drafted -> new`, actor Operator, reason "Operator undid the shortlist") and the Spec draft is discarded (path, hash, error, retry time, attempts and any queued revision cleared; `spec.md` deleted). It is refused from any other status (a `new` Proposal makes it a no-op). Spec runs execute in the worker process (`draftSpec`/`reviseSpec` call `brain.run` in-process), which registers each run's abort in a per-Proposal `RunCancels`; the undo aborts the run in flight, killing the `claude` child, and the run records itself in `brain_runs` as `cancelled` with whatever cost and session the killed child reported (0 when none), with no `spec_error` and no re-draft. Runs already finished keep their spend on the card. The worker applies commands on their own 5 s timer as well as at the start of each tick, because the tick waits for a Spec run (up to the `spec` timeout), and a cancel must not queue behind the run it cancels. Race safety: `completeSpec` re-reads the status inside its own write transaction and refuses (`new -> spec-drafted` is not a transition), so an undo that lands as the run completes either lands first (the run is recorded and nothing else happens; the `spec.md` it wrote is removed) or lands after (the Spec is discarded); a Proposal that is un-shortlisted is never flipped to `spec-drafted`. Expiry: `new` counts its 48 h from the Proposal's creation (`created_at`), not from its latest transition into `new`, so an undo does not restart the clock; the consequence is that a Proposal undone after more than 48 h since creation is closed (`stale`) by the next worker tick. `shortlisted` still counts from its latest transition, so a re-shortlist gets its own 7 days.

Recovery from `build-failed` (decided in ticket 08): the card shows the exact `claude --resume <session_id>` command, and the Operator can `requeue` the Proposal (`build-failed -> approved`, a transition of its own with the Operator as actor; the plain `approve` command is refused from `build-failed`). A re-queued Proposal goes to the back of the Build queue (its approval time is now) and gets a fresh Build, entering the runner like any approved Proposal. The runner refuses to build over an existing `~/code/<slug>`, and `gh repo create` would fail on the existing private repo, so before re-queueing the Operator removes both. The worker enforces this when it applies the command: while `~/code/<slug>` or the private GitHub repo (asked of `gh repo view`) still exists, the command is rejected (the repo counts as absent only on `gh`'s exit 1 with GitHub's own not-found text and a token that can be shown to read private repos, i.e. with the `repo` scope; GitHub answers "not found" alike for a repo that does not exist and one the token cannot see, so a token without that scope, or one that reports no scopes, gets an error naming the problem instead, and the command is retried), the Proposal stays `build-failed`, and the rejection (shown on the card) names what to remove: the local directory, the GitHub repo, and the Cloudflare Worker when the Build deployed one (`workerDeployed`). Nothing is ever deleted by argus, and a leftover repo is not reused. The per-Build home is kept for `build-failed` (so the session can be resumed) and deleted on `built` and on `dismissed`: the lifecycle module removes it when the Operator's dismissal is applied, except for a Proposal dismissed while `building`, whose home the runner removes when that Build ends (the container still has it mounted until then). A crash in between would leave that home, so worker start also removes the home of every dismissed Proposal that has no Build run alive (`sweepDismissedHomes`).

## 4. Build Runner

One Build at a time, FIFO by approval time. The brain (research) may run alongside. The Build Runner is a module in `packages/core`, driven by the worker process.

<!-- Not generated: this call sequence (retry branches included) is hand-written. The pipeline graph in packages/core/src/pipeline-graph.ts leaves that level of detail out on purpose, and the Build node on the "How it works" page points here. -->
```mermaid
sequenceDiagram
  autonumber
  participant Op as Operator
  participant W as Worker (Build Runner)
  participant GH as GitHub
  participant CC as claude -p child
  participant CF as Cloudflare
  participant WR as War Room log

  Op->>W: approve(proposalId)
  W->>W: enqueue, wait for free Build slot
  W->>W: clone argus-build-template into ~/code/slug
  W->>GH: gh repo create slug (private, personal owner)
  W->>W: write Spec to the repo, disclosure footer included
  W->>CC: podman run the Build container: claude -p "/implement-spec ..." (acceptEdits, scoped allowedTools, max-budget-usd, 4h wall clock, stream-json)
  CC-->>WR: stream-json events piped to the log
  alt First attempt fails
    CC-->>W: non-zero exit or budget or time cap hit
    W->>CC: one automatic retry, failure report appended to the prompt
  end
  CC-->>W: exit code, result with session_id and total_cost_usd
  alt Build succeeds (first attempt or retry)
    W->>CF: wrangler deploy to slug.workers.dev
    CF-->>W: preview URL
    W->>W: status built, record cost per Proposal
    W-->>WR: build done notice (also Telegram, with the preview link)
  else Retry also fails
    W->>W: status build-failed, store session_id for claude --resume in tmux
    W-->>WR: build failed notice (also Telegram)
  end
```

Mechanics:

- Command shape (flags per the journal's guide facts): `claude -p "/implement-spec <proposalId>" --permission-mode acceptEdits --allowedTools "<scoped list>" --max-budget-usd <BUILD_MAX_BUDGET_USD> --output-format stream-json --verbose`, cwd `~/code/<slug>`, with a 4 h wall-clock timeout enforced by the worker (stop the container, treat as failure). The `<scoped list>` and the budget value are config in `packages/core`, set in the Phase 1 ticket. The argv is unchanged by containment; it runs as the command of a rootless podman container (ADR 0005), built by `buildPodmanRunArgs` in `packages/core/src/sandbox.ts`:
  `podman run --rm --name argus-build-<id>-<nonce> --label argus.build=<id> --label argus.role=agent --label argus.data=<id> --label argus.owner=<pid.start> --pull=never --init --log-driver=none --userns=keep-id --cap-drop=all --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=2g --tmpfs /var/tmp:...,size=256m --tmpfs /run:...,size=64m --pids-limit=1024 --memory=8g --cpus=4 --timeout=<wall clock + 60 s> --network argus-build-net -v <repo>:<repo>:Z -v <data>/proposals/<id>/home:/home/agent:Z -w <repo> --env ... localhost/argus-build:<tag> claude <argv above>`. `podman run` stays attached, so stream-json still arrives on its stdout. The token flag is `--env CLAUDE_CODE_OAUTH_TOKEN` with no value: podman copies it from its own client environment, so it is not on any command line.
- Three containers per Build, one image (ADR 0005): `agent` as above; `install` (`pnpm install --frozen-lockfile` in a fresh export of the checked commit, same network and proxy, no token); `bundle` (`wrangler deploy --dry-run --outdir --metafile` over that export, `--network none`, no token). The `agent` and `install` containers each get a fresh egress sidecar (`node /opt/argus/egress-proxy.mjs`, on `argus-build-net` at 10.89.77.2 and on the default `podman` network) that tunnels only `api.anthropic.com:443` and `registry.npmjs.org:443`; its denials are copied into `build.log` as `argus-egress: denied <host>`. On timeout, abort and shutdown the worker runs `podman stop -t 5` then `rm -f` by name on the container and its sidecar, each call bounded (a hung podman is killed, noted in the Build log and passed over, and the host-side process group is killed regardless); an abort also cuts short the sidecar start and its `logs` polls; `--timeout` is the backstop, and worker start removes leftovers that carry this data directory's label and whose owning worker is dead. Missing podman, image, network or token refuses the Build and leaves the Proposal `approved`. Caps are 8 GiB, 4 CPUs, 1024 pids and 2 GiB `/tmp` by default (plus a fixed 256 MiB `/var/tmp` and 64 MiB `/run`), overridable with `ARGUS_BUILD_MEMORY_GIB`, `ARGUS_BUILD_CPUS`, `ARGUS_BUILD_PIDS`, `ARGUS_BUILD_TMP_GIB` (a bad value is an error). A tmpfs is memory, so all three tmpfs together may take at most half the memory cap (2.31 of 8 GiB by default, leaving 5.7 GiB for the processes); a combination beyond that is an error too.
- Scoped tools (`BUILD_ALLOWED_TOOLS` in `packages/core/src/brain.ts`): file tools plus only the shell commands `/implement-spec` needs (`git add/commit/status/diff/log/show`, `pnpm install/add/check/test/typecheck/lint`, `ls`, `mkdir`, `mv`); no bare `Bash`, no push, no deploy. The Build repo's own `.claude/settings.json` adds deny rules; `--strict-mcp-config --setting-sources project` keeps the Operator's user-level setup out. The Build container's environment is not scrubbed from the host's; it is built from nothing: exactly the variables in `containerEnv` in `packages/core/src/sandbox.ts` (`HOME=/home/agent`, `CLAUDE_CONFIG_DIR`, the proxy variables, a fixed git identity with `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` set to `/dev/null`, `CI=1`, the telemetry and autoupdate opt-outs, and `CLAUDE_CODE_OAUTH_TOKEN` in the `agent` container only). That token is a separate `claude setup-token` token for Builds, read from `ARGUS_BUILD_TOKEN_FILE` (default `~/.config/argus/build-token`, mode 600) on each Build and never the brain's. No `ANTHROPIC_API_KEY`, GitHub, Cloudflare or npm credential exists in any container; only the host `wrangler` and `gh` see those. The podman client itself gets only `PATH`, `HOME` and `XDG_RUNTIME_DIR`, plus the token for the `agent` container. Adding a mount, flag or variable without updating the allowlist in `containment-policy.ts` fails a test, and `pnpm verify:boot` and `pnpm verify:contain` check the policy against the dry run and real containers.
- Success is decided by argus, never by the Build's own checks: (1) the last line of the final `result` text carries no `ARGUS_` marker (README contract); (2) HEAD advanced past the Spec commit; (3) the working tree is clean; (4) `scripts/`, `.claude/`, `.github/` and the `scripts` field of `package.json` match the template commit; (5) the entry point `src/index.ts` is a real file inside the repo. Before any repo is created, and again right before deploying, the runner asks the Cloudflare API whether a Worker with the slug's name already exists and fails the Build if so (or if the account cannot be checked); it never overwrites one. The bundle is made in the `bundle` container (above), where the repo's `node_modules` exist and no host file or credential does; the host then requires every input in the esbuild metafile to lie inside the exported commit and the output directory to hold only the entry, and deploys that checked entry with the global `wrangler deploy --name <slug> --config <file> --no-bundle`. The config is written by argus (name, `main` and a compatibility date, nothing else) and the Build's own `wrangler.jsonc` is never read; no script from the repo's `node_modules` runs on the host. It crawls the preview itself (`checkDisclosure`: same-origin links from `/` plus a 404 path) and requires argus's own copy of the disclosure sentence as visible text (not in hidden, `noscript`, `template`, script or style content) on every HTML page. Only then is the Proposal `built`, with the preview URL. The Build agent can write `.git/`, so runner git never reads the machine's global or system config, and after the agent has run it never reads the repo's `.git/config`, hooks or attribute drivers either: the checks and the final push use a git directory of argus's own that borrows only the repo's objects, and the push goes to the origin URL recorded before the agent started. The Build's brain run stays open until the Proposal's terminal state, and the startup sweep also fails a `building` Proposal that has no open run, so a crash mid-deploy cannot block the queue. Host-side runner commands (git, `gh`, `wrangler`) are spawned in their own process group and a timeout or shutdown kills the whole group; everything the agent runs lives in a container's own PID namespace under `--init`, so stopping the container kills grandchildren too.
- `stream-json` lines are appended to `.data/proposals/<id>/build.log` and tailed live by the War Room. The final result line supplies `session_id` and `total_cost_usd`.
- The retry is the same command with the failure report (the error plus the last 25 lines of the Build log, each cut to 300 characters) appended to the prompt, run once. It follows any failure after the setup (the clone, the private repo and the Spec commit): a non-zero exit, the `--max-budget-usd` cap, the 4 h wall clock, an `ARGUS_BUILD_FAILED` last line (its summary is in the report), a failed check, bundle, deploy or preview crawl. It does not follow a setup failure, a worker shutdown, `needs-human`, a Proposal dismissed meanwhile, or a Worker name that someone else holds (checked again just before the deploy, after the claude run; no second claude run is spent on it). A failure after this Build's own `wrangler deploy` (the preview crawl, say) is retried, and the retry redeploys over the Worker the Build deployed: the Build's state records that attempt 1 deployed, and only then does the name check let an existing Worker of that name pass. Each attempt has its own brain run (the first is closed and the second opened in one transaction), so the cap and the cost are per attempt: a Proposal can use up to twice the build budget. Before the retry the runner discards uncommitted work: from a git directory of its own that borrows only the repo's objects (so the agent's `.git/config`, hooks and attributes are never read) it resets the work tree to the repo's last commit and removes untracked files (`git clean -ffd`; ignored files such as `node_modules` stay), then replaces the repo's index with the one that produced. The retry starts from a clean tree. After the retry fails the Proposal is `build-failed` with the session of its latest run that has one (a run killed by a cap prints no result, so its session is taken from the stream's `system`/`init` message, and only a UUID is stored), and the Operator can attach in tmux on the host with `cd ~/code/<slug> && CLAUDE_CONFIG_DIR=<argus>/.data/proposals/<id>/home/.claude claude --resume <session_id>` (the session lives in the per-Build home, not in `~/.claude`). The War Room computes that text with `resumeCommand` (`sandbox.ts`) and shows it on the card of a `build-failed` Proposal. A run killed by the wall clock or a shutdown prints no result, so it records $0: the per-Proposal cost undercounts for Builds that hit the cap (up to the $25 build budget per attempt). Recovery after the retry fails is in section 3.
- The `/implement-spec` skill lives in `argus-build-template` (`.claude/skills/`) so every Build gets the same instructions, lint, CI and disclosure footer.
- A Build that is killed by budget or time cap counts as failed, and enters the retry like any other failure.
- Notifications: the Build Runner reports to the War Room log and to Telegram (`notifier` in `BuildRunnerOptions`, `packages/core/src/telegram.ts`): build start, build done with the preview link, and the final build failed (not a retried first attempt). Messages are plain text, queued (bounded, oldest dropped) and sent in the background with backoff, so Telegram being slow or down never holds up a Build; the bot token is redacted from every logged error. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` come from the environment or the repo-root `.env`; without them notifications are off with one warning, and a dry run logs the message instead of sending it.
- Builds never fall back to the API backend; if the subscription window is exhausted they wait (section 5).

### Operator setup for Builds

Real Builds need these, once (ADR 0005). `pnpm check` and `--dry-run` need none of them; `pnpm verify:contain` prints SKIP without podman, the image or the network.

1. Rootless podman with subuid/subgid ranges for your user. Argus never uses a socket, root or `sudo`.
2. Build the image and create the network: `pnpm image:build`. It creates `argus-build-net` (`--internal --disable-dns`, 10.89.77.0/24, idempotent; it refuses an existing network that is not internal and DNS-less) and builds `localhost/argus-build:<tag>`, printing the tag on its last line. The worker derives the same tag from the checkout, or you set `ARGUS_BUILD_IMAGE`. The worker never builds or pulls. Re-run after bumping Claude Code, Node, pnpm, the Containerfile or the proxy.
3. Mint the Build token with `claude setup-token` (separate from the brain's) and save it as one line in `ARGUS_BUILD_TOKEN_FILE` (default `~/.config/argus/build-token`), `chmod 600`. A file readable by others, empty or multi-line is refused.
4. Optional: `ARGUS_PODMAN_BIN` for a podman at another path. The worker and every script (`image:build`, `verify:contain`) read this one variable; `image:build` still accepts the old `PODMAN` when it is unset, with a deprecation warning.
5. Check it: `pnpm verify:contain` (real containers, no claude run, dummy token, no spend) and `pnpm verify:boot`.
6. To continue a failed Build's session, run the resume command from the section above.

## 5. Brain

The `Brain` interface is the single seam for all LLM work. Callers ask for a task and get structured output plus cost.

```ts
type BrainTask = 'judge' | 'propose' | 'spec' | 'build' | 'meta-summary' | 'meta-group' | 'meme-ideas' | 'researcher' | 'research-terms';

interface BrainRun<T> {
  output: T;
  sessionId?: string;     // claude-code only, enables resume
  totalCostUsd: number;   // recorded per run per Proposal
  backend: 'claude-code' | 'api';
  model: string;
}

interface Brain {
  run<T>(task: BrainTask, input: BrainInput, opts?: { maxBudgetUsd?: number; resume?: string }): Promise<BrainRun<T>>;
}
```

**ClaudeCodeBrain** spawns `claude -p` as a child process, with skills in `argus/.claude/skills/` (one skill per task, invoked as `/name` in the prompt) and `--output-format json` to read `session_id` and `total_cost_usd`. Auth is a long-lived token from `claude setup-token` exported as `CLAUDE_CODE_OAUTH_TOKEN` (valid one year, paid plan). `ANTHROPIC_API_KEY` must be unset in the child environment or it wins over the subscription. The long-lived token also avoids OAuth refresh contention between concurrent children. Concurrency has no documented problem; the rate limit is shared with the Operator's own Claude usage.

**ApiBrain** (`packages/core/src/api-brain.ts`) uses the Anthropic SDK (`@anthropic-ai/sdk`, pinned) with the same skill markdown as the system prompt (front matter removed, plus a note that this run has no tools), pay-as-you-go. Same inputs, same output schema: it returns the model's raw text and the judge and propose passes parse it with the same strict parsers as a `claude -p` answer, so it stays untrusted input. It runs `judge` and `propose` only (a spec or build run is refused before any request), on `claude-haiku-5-5` ($0.10 in, $0.50 out per million tokens; `API_PRICES`, a model with no price there cannot be configured), as one non-streaming request with no tools, thinking off, `max_tokens` 1024 (judge) or 2048 (propose), no SDK retries (a retry is a second bill) and a 60 or 120 second timeout. Unlike `claude -p`, its runs cost real money, so:

- **Real-dollar cap, in code.** `MAX_API_DAILY_USD` ($0.50 per rolling 24 hours) is checked before every call: the call is not made if the dollars already spent plus the most it can cost (its ceiling: every prompt byte as an input token plus all of `max_tokens` as output) would pass the cap. Per run the ceiling must also fit the route's cap ($0.01 judge, $0.02 propose). A spend that cannot be read counts as a spent cap (fail closed). `ARGUS_API_DAILY_USD` can only lower the cap; a value above the one in code, zero or not a number is an error at startup, and raising the cap is a reviewed code change (invariant 3).
- **Cost** is the provider's reported usage times the price (cache tokens at their dearest rate). A failed or partial call is counted too: a rejected request (4xx) was not served, so it costs $0; a 5xx, a cut connection, a timeout, an abort in flight and an answer with no usage have unknown cost and are charged at the call's ceiling. The ledger is `brain_runs` rows with `backend = 'api'` (`Datastore.apiSpendSince`): finished rows at their cost, rows still in flight or ended with no cost at the route's per-run cap. API rows are left out of every Est. usage figure (the judge's and the research budget's dollars, and a Proposal's `agentCostUsd`), which count subscription runs only; the run caps still count them as runs. A run is recorded under the backend that served it (`finishBrainRun` takes `backend` and `model`).
- **The key.** `ANTHROPIC_API_KEY` is read by the worker only when `ARGUS_API_FALLBACK=1`, from its environment or the git-ignored `.env` (only that name; a variable set to the empty string wins over the file; `ARGUS_NO_DOTENV` skips the file), handed to ApiBrain and deleted from the worker's environment, so no child process inherits it (the `claude` scrub, the Build container allowlist and the host tools' environments already exclude it). ApiBrain keeps it in a private field, gives the SDK everything it would otherwise read from the environment (key, endpoint, no auth token, no logging), and rebuilds every error from the HTTP status alone, with no cause chain and the key redacted, so it appears in no log line and no stored run. The endpoint is `ARGUS_ANTHROPIC_URL` or the real API, never the SDK's `ANTHROPIC_BASE_URL`.
- **Dry run.** `--dry-run` logs the request (`[brain] dry-run: POST <url>/v1/messages model=... prompt=...`) and sends nothing; it needs no key.

Routing is data (config file, overridable per task), not code branching:

| Task | Backend | Model |
|---|---|---|
| judge | claude-code | haiku |
| propose | claude-code | sonnet |
| spec | claude-code | sonnet |
| build | claude-code | sonnet |
| meta-summary | claude-code | haiku |
| meta-group | claude-code | haiku |
| meme-ideas | claude-code | sonnet |
| researcher | claude-code | sonnet |
| research-terms | claude-code | haiku |

The `meta-group` task (ADR 0015 decision 4, meta-redesign ticket 06) groups the trending tokens that passed the filter and the top 30 launch themes into named subjects, inside each Meta tick (every 15 minutes; a subject keeps its key and state across runs through the stabiliser, and a graduate no exact form places can join a weak subject by name blend, ADR 0019), as one JSON object (`{"subjects":[{"name","items":[ids]}]}`) that argus validates by structure (`parseMetaGroups`): the model sees ids, never mints, and an id it was not given, an id used twice, an empty or over-long subject, or a name with markup, a URL or a control character refuses the whole answer. It decides only grouping and names; a subject's themes are its `H` members, its counts are recomputed from the union of their tokens (distinct creators, never a sum), its key is that of the member theme with the most creators, and its leader, caps and copiers come from code. The items are creator-written, so they go in as one cut JSON-quoted line each inside a block that ends only at a fresh random boundary line; it has no tools, a haiku run of at most $0.05 and 2 minutes, and no API fallback. Before any call a tick checks, in order: `ARGUS_META_GROUP_AI=0` or no Brain (rules), the API-fallback hold (rules), reuse (the same trending mints and theme keys as the last good answer, under 60 minutes old, costs nothing: what keeps 96 ticks a day inside the cap), the failure back-off (three failures in a row skip the next two ticks), the daily cap (`ARGUS_META_GROUP_MAX_DAILY_USD`, $1.00 in any rolling 24 hours from `brain_runs`, a run with no reported cost charged at its $0.05 route cap) and the shared research budget. With no answer the tick groups by rules and says so (`named_by: rules`): a subject's key and label are the ones most distinct creators used, and spelling aliases merge strictly (`aliasKey`: `gta 6`, `gta6`, `gta vi` and `gtavi` are one). The checked answer is stored in `meta_groupings` (pruned with the runs), and each `meta_current` row carries `named_by` and its member `themes`. It counts in the research share. The War Room (ticket 07) shows each Meta's and Watching row's name as its title and, under it, an `Includes` list of the merged themes (the first 5 as `<label> - N tokens, M creators`, then `+N more`; `GET /api/current-meta` sends at most 12, without their keys), so a bad merge is visible; as text only, and no list when nothing was merged.

The `meme-ideas` task (ADR 0013, missed ideas ticket 06) writes three meme ideas for a current Meta (ADR 0014), when it becomes one and every 12 h while it stays one, or for a news story that failed the buildability gate (proposal-routing ticket 04: the story's headline, summary, Signals and the judge's reasons form the untrusted block instead of a Meta's), as one JSON object that argus validates field by field (`parseMemeOutput`); it has no tools and no API fallback. The Meta's token names and descriptions and the matching headlines are untrusted: they go in as one-line data inside blocks that end only at fresh random boundary lines. It runs only when `ARGUS_MEME_IDEAS=1` (default off), at most one trio per Meta per 6 h and 24 runs a day (`ARGUS_MEME_MAX_PER_DAY` sets it, up to a hard ceiling of 40), counted in `brain_runs` and the research share. A name or ticker that copies a token of the Meta's group, or a live token DexScreener lists (liquidity of at least $5,000 and a market cap of at most 100 times it, the Moment scans' real-clone test, `meme/live-token.ts`), is refused by the distinct-name rule; the answer goes back once with the copied names listed, then nothing is stored. A copy of a dead or drained token is not refused: the idea is stored with a note ("name also used by a dead token: Dexter $2.9K", `proposals.meme_copy_note`) that the card shows. Any other refusal of the answer (a ticker over 10 characters, a wrong key set) goes back once too, with the exact error in the prompt (meta redesign ticket 16); the two retries are independent, so a request makes at most three runs. The three ideas are stored as `meme` Proposals in one transaction with an immutable Meta snapshot. A third source is the Operator's angle (ticket 11, ADR 0013 amendment): the War Room writes one `meme_angle_requests` row, the worker's `runMemeAngles` runs it through the same loop with the angle as a third fenced block (the link split out by code and replaced by its host; nothing fetches it), and the trio carries `proposals.operator_angle`; it does not block, and is not blocked by, the Meta's automatic trio.

The `researcher` task (human researcher ticket 05, ADR 0017) turns a topic the Operator typed on the Research page into a Research brief. The War Room writes one `research_requests` row (insert only; one waiting at a time, 20 in 24 hours) and nothing else; the worker's `runResearchRequests` (`research/researcher.ts`, on the fast tick like the angle step) takes it, searches DexScreener for the topic by code, reads X through the scanner's child process and its shared session gate (the logged-in profile, `ARGUS_CHROME_BIN`; 2 page loads a run and 20 a day of research's own, counted in `moment_scans` under the label `research: <topic>` so the scanner's cap sees them; a stopped session, a held browser or a refused reader only put a note in the brief), and then makes one sonnet run with the web tools `WebSearch` and `WebFetch` and no other (no API fallback: it waits out a rate limit). The topic (Operator-typed), the X posts and the coin names (DexScreener) are three fenced blocks of untrusted data under fresh random boundaries, flattened and cut; the model sees coin ids, never addresses, and answers one JSON object (`story`, `sources`, `coins` by id, `freeNames`) that argus validates field by field (`parseBriefOutput`); one miss goes back once with the exact error, a second ends the request `failed` with the reason. The brief's coins are the model's chosen candidates with market cap and bonded state taken from DexScreener by code (`unknown` when the lookup was cut or failed, never guessed), a source link is kept only if `http` or `https`, and a free name is dropped when a live token already uses it. Caps, in code and not raisable by configuration (`research/brief.ts`): 6 runs and $3.00 charged in any rolling 24 hours, $0.75 a run (passed to the Brain, which takes the lower of it and the route's), all inside the shared research budget; a capped request ends `capped` with the reason and is never left waiting, while a rate limit, a shutdown or a dry run leaves it waiting. Every run is a `brain_runs` row (task `researcher`, opened before the child starts, linked to the request in `research_requests.run_ids`) and the page shows each request's cost. Tables: `research_requests`, `research_briefs`. Dry run: `pnpm research:dry-run "<topic>"` prints the exact argv and the rendered prompt with sample data and calls nothing. What the run's WebFetch may reach (ticket 12): `buildArgs` adds, to every task whose tools include WebFetch, the CLI's own deny rules (`--disallowedTools "WebFetch(domain:localhost)" ...`, literal hostnames only: the CLI cannot match a range or a resolved address) and a PreToolUse hook on WebFetch (`--settings`, `research/fetch-guard-hook.ts`) that refuses loopback, private, link-local and reserved addresses in any spelling, this machine's own names, non-default ports, credentials, and hostnames that resolve to such an address or not at all; a hook that cannot start blocks too (`|| exit 2`). A DNS answer that changes between the check and the fetch (rebinding) is not caught. Sources in a brief show their host beside the link, open without opener or referrer, and are never called verified. A research run's X loads stay in `moment_scans` as `research: <topic>` and the Moments page leaves them out.

The `research-terms` task (research widen ticket 02, spec `.scratch/research-widen/spec.md`) is the first step of a research request, so the brief finds coins the literal topic misses: one Haiku run with no tools, no API fallback and a $0.05 cap (`research/terms.ts`, skill `.claude/skills/research-terms/SKILL.md`). Its input is the Operator-typed topic only, in a fenced untrusted block; its output is `{"terms":[...]}`, which argus validates (each term 2 to 20 plain letters or digits, de-duplicated, at most 15; any other answer is a failure). It runs only inside a request, after the cap check and the literal DexScreener search and before the researcher run; a dry run skips it. The run is a `brain_runs` row of its own, tied to the request, counted in the research spend and the shared research budget but not in the researcher's 6 runs and $3 a day, so one request costs at most $0.80 (a repair retry adds a second researcher run). The terms join the local match of the migrated coins, and the first 8 are searched on DexScreener one after another (Solana pairs with a plain address, a price and a mint ending `pump`); a failed or rate-limited search ends the searching and keeps the hits so far. A terms step that fails or returns nothing valid never fails the brief: the topic alone is used and the brief's note says so.

The `meta-summary` task writes the one-line summary of a Meta or a Watching subject (at most 6 in all, Metas first; launch themes get the numbers line only; no tools, a judge-sized haiku run, no API fallback); it counts in the research share. A Meta is several tokens graduating on one narrative (ADR 0018, which supersedes the market-cap rule of ADR 0014 and the copies rule of ADR 0015; the trending-list and DexScreener paragraph that follows describes the leader display and the trending list, and market cap there is display only): at least `ARGUS_META_MIN_GRADS` (10) pump.fun graduations (`study_tokens.migrated_at`; bonk is ignored) in 24 h on one subject from at least `ARGUS_META_GRAD_CREATORS` (6) creators and `ARGUS_META_LIVE_GRADS_6H` (3) in 6 h; it stays with `ARGUS_META_STAY_GRADS` (5) in 24 h; Watching is `ARGUS_META_WATCH_MIN_GRADS` (5) in 24 h or `ARGUS_META_WATCH_GRADS_6H` (3) in 6 h. What is a Meta is plain code too (the rule is ADR 0018, above; this part is the trending list and how a leader is shown, display only): every Meta tick reads the trending tokens (any age, any launchpad) top-down (ADR 0015, meta-redesign ticket 05): it reads what is trending now on Jupiter (`toptrending/1h`, one request) and GeckoTerminal (Solana `trending_pools`, three pages), at most `ARGUS_META_TOPDOWN_CALLS` (5) requests in all, retries included, merges them per token and drops fakes (liquidity under $50,000, a market cap over 100 times the liquidity, or 24 h volume under $50,000), tokenized stocks, quote tokens and generic names; DexScreener only verifies the survivors (the same three tests on its own figures, the cap-to-liquidity one reading the larger of its liquidity and the list's, the list's only for a token whose Jupiter organic score is at least `ARGUS_META_TOPDOWN_MIN_ORGANIC` (50), and the market cap of the deepest pair) within `ARGUS_META_LEADER_CALLS` (4) lookups, last tick's leaders first and on the old rule so a Meta already held is never dropped by the filter, and the biggest token of each top launch theme still counts. A trending token is matched to the subject that carries it and may be shown as its leader, never deciding a Meta; the tick stores every candidate it read, kept or dropped, with the reason (`meta_candidates`). The `dexscreener:trending` Signals (paid boosts) stay Signals but are no longer a leader source. A failed list never stops the tick. The tick stores at most 3 Metas (graduation rule above) and up to 3 Watching subjects in `meta_current`. The launch-theme ranking (clone clusters ranked by creators) is stored as before and is now context, "All launch themes". No Brain call, Narrative, Proposal or Score is involved. So is **New Meta** (meta-redesign ticket 03, replacing Hot now): after each Meta tick the worker compares the newest run's Metas with the run before it and stores one event (`meta_new_events`) for each subject that is a Meta now and was not then (nothing on a first run or after a pause longer than `ARGUS_META_STATE_MAX_MINUTES`), live for 6 h. The War Room shows the live events (home page and `/meta`, `GET /api/new-metas`) with the Meta's leader, summary and the matching news; the judge and propose prompts carry the Metas and the Watching subjects with their leader caps. News is context only (ADR 0011): context-class Signals of the last 24 h whose title names the Meta's subject key are shown beside the event and sent to the `meta-summary` prompt in its own untrusted boundary, and never raise an event or make a Narrative.

There is no `study` task. The Study (phase 3a) is plain code today: PumpPortal events, Snapshot capture under the versioned capture rule (`STUDY_CAPTURE_RULE`, version 1), chain labels, with its own capture cap (`MAX_CAPTURE_RUNS_PER_DAY`); it spends no Claude, and `BrainTask` has no `study` (`DEFAULT_ROUTING` has no row for it). A blind study run is planned (phase 3 ticket 07, not built). It would read one frozen Snapshot as delimited untrusted data, with no tools, web or `--chrome`, never see the label, and return fixed JSON notes per axis (Narrative, Identity, Tech), validated like a Score; it would need its own `BrainTask`, a routing row and its own caps (a rolling-24h run cap of about 100 runs a day, lowerable, and a per-run `--max-budget-usd`), never borrow from the judge's or propose's budgets or from Builds, and have no API fallback. The "How it works" page draws the Study with no Claude cost, and the sync test (`packages/core/src/pipeline-graph.test.ts`) will ask for the node's `brainTask` the day a `study` task appears in `DEFAULT_ROUTING`.

Fallback rule: when the subscription window is exhausted (rate-limit exit from `claude -p`), `judge` and `propose` switch to `api` / `haiku` for the rest of the window. Only `judge` and `propose` fall back; `spec`, `build`, `meta-summary`, `meta-group`, `meme-ideas` and `researcher` stay on claude-code and wait until the window resets (builds never fall back: `runPendingBuilds` is handed the `ClaudeCodeBrain` itself). Total research spend is bounded by a daily quota share of about 30% of the subscription so research cannot starve builds.

The fallback is **off by default**: `ARGUS_API_FALLBACK=1` turns it on (and needs a key, else the worker says so and stays off). It is a `FallbackBrain` (`api-fallback.ts`) around the two backends. Claude is always asked first. A `rate-limited` claude run of any task (the window is one window) starts a hold: until the reset time claude reported (a rejected `rate_limit_event`'s `resetsAt`, or the epoch after `usage limit reached|`), never more than 6 hours ahead, else for 15 minutes. The run that hit the limit and every judge or propose run during the hold are served by the API; `routeFor` reports the API route meanwhile, so the in-flight row is opened as `api`; and the run that hits the limit (whose row was opened as `claude-code`), like any run whose hold began after its row was opened, is announced through `BrainRunOptions.onBackend` and booked as an `api` run (`Datastore.setBrainRunBackend`) BEFORE the request is sent, with no await between that and the cap check. From then on the row counts in the real-dollar ledger at its task's per-run cap, so overlapping passes see each other's runs and a crash leaves the charge standing (an orphaned row is swept to `interrupted` and is still charged at that cap). If the switch cannot be recorded, nothing is sent. When the hold is over claude is asked again, and a hold never shortens a running one. A plain failure, a budget stop or a timeout of claude never falls back. If the API refuses (its cap) the run fails as the rate limit it was, which ends the pass and leaves the Narrative queued, so reaching the cap stops research for the day without marking anything as failed. Judge and propose passes are otherwise unchanged. The War Room shows each run's backend (Proposal details, Narrative details), the Proposal's API spend, and on the home page today's API spend against its cap, apart from Est. usage.

Every run stores `total_cost_usd` (API runs compute it from usage) against the Proposal, so the card shows agent cost so far.

Why not cloud scheduled tasks or the Agent SDK is in ADR 0001. Reference docs (fetched 2026-11-04): https://code.claude.com/docs/en/headless.md (print mode, `--output-format`, `--allowedTools`, `--resume`, `--max-budget-usd`), https://code.claude.com/docs/en/authentication.md (`claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` precedence), https://code.claude.com/docs/en/routines.md (cloud scheduled tasks: 1 h minimum, fresh GitHub clone, no local files), https://code.claude.com/docs/en/scheduled-tasks.md (in-session `/loop` and CronCreate: fire only while a session runs, 7-day expiry).

## 6. Sources (v1)

All v1 Sources are unauthenticated and sit behind the `Source` interface (`id`, `label`, `poll(): Promise<NormalizedSignal[]>`, ported from helios):

| Source | Kind | Notes |
|---|---|---|
| RSS catalog | news feeds | Ported from helios `sources/rss.ts`. Feed list is data. |
| Google Trends RSS | trends | Helios `trends-feeds.ts` pattern; `sources/google-trends.ts`, `trends.google.com/trending/rss?geo=US`. |
| PumpPortal events | launchpad | Ported from helios `sources/pumpportal-bonding.ts`; shows what already has a token. |
| DexScreener trending | launchpad/market | New; `sources/dexscreener.ts`: top boosts for Solana, named through the token lookup. `DexScreenerClient` (with `search`) is the client the collision checks reuse. Its network fetch is wrapped in `retryingFetchText` (`sources/http.ts`, meta-redesign ticket 04): a network error, timeout, 408, 425, 429 or 5xx is tried again twice after 500 ms then 1 s (a Retry-After is a floor, no wait over 5 s), so a lookup counts as failed, for the Meta tick's streak too, only after its retries; other 4xx and bad bodies are never retried. Google Trends and DexScreener are wrapped in `BackoffSource` (doubling wait, honours Retry-After). |
| GitHub trending | tech | New; `sources/github-trending.ts`: the public search API, repos created in the last 7 days by stars, keyless, 10 requests a minute (ADR 0008). Wrapped in `BackoffSource`. |

No X as a Source. The helios cookie scraper is not ported. X data enters only through the Study's dedicated, read-only, logged-in browser capture (ADR 0009, Playwright in a dedicated Chrome directory, about 200 captures a day, saved as untrusted text in Snapshots); it is not a `Source` and produces no Signals.

Read-only data sources of the Study (not `Source`s; they produce no Signals and sit behind the Study's own readers):

- **Helius** (RPC, Free plan first, key in `HELIUS_API_KEY`): event times and labels from chain, curve `complete` reads at 24h and 7d, wallet analysis for migrators only. Credits are counted per run and per day against a cap in code. Every call goes through the per-verb wrappers in `packages/core/src/study/helius.ts` (the one file ADR 0002's Amendment allows to name the host and the read verbs). Chain-sourced creates (Phase 3 ticket 20, `study/chain-creates.ts`) use three of them: a migrated mint's create is read with one ascending history call (10 credits), and once a day a seeded random sample of the previous UTC day's creates is listed (1 credit a page of 1,000) and read (1 credit each) as the comparison population, each row stored with its day and sampling weight. Such rows carry `source` `chain_migrated` or `chain_sample`, are never due for a Snapshot, and are outside the base rate; the daily cap is `ARGUS_CHAIN_CREATES_DAILY_CREDIT_CAP` (25,000 by default, 33,000 at most).
- **Our own Helius-based chain labeller** produces the on-chain risk labels and the bot-filter raw metrics. No third-party risk-scoring API is used.
- **PumpPortal** create and migrate events, over the existing `PumpPortalSource` connection (only one WebSocket is allowed, so the Study opens no second one).
- **DexScreener** market data for own-launch outcomes and post-migration price change.

## 7. Rubric

Dimensions, scored per Narrative and carried onto its Proposal: **momentum**, **novelty**, **buildability** (hard gate: below the gate the Narrative never becomes a Tech Proposal; a news Narrative that also passes the legitimacy, hook and momentum floors can become a meme Proposal, ADR 0013), **hook**, **legitimacy**. Weights are equal in v1. **Legitimacy (Rubric v3, missed ideas ticket 04)** scores low (0 to 2) for impersonation (a token, account or Tech pretending to be a real person, brand or project, claiming to be official, or using a name as a fake endorsement), fraud (a false claim meant to take money) and hate or harassment; satire, parody, jokes and news-based memes about public figures are not penalised, and a real person in the story is shown as a risk, not scored down. The text is `LEGITIMACY_RULE` in `packages/core/src/rubric.ts`; a database whose history lacks it gets one new version at startup (the latest with only `legitimacy` replaced, gate and weights kept, v1 and v2 rows and their Scores untouched, nothing re-judged). The Rubric (dimension descriptions, weights, gate) is editable data in the War Room and stored in the datastore, not in code. The brain `judge` task reads it at call time. New Signals on an existing Narrative trigger a re-score; every Score is stored, so history is kept and shown in the details view.

The judge pass (`packages/core/src/judge.ts`, every 30 minutes) is the delta: it scores a `news` Narrative of the current embedder (never another embedder's; a launchpad Narrative is context and routing only and is never judged or proposed from, ADR 0013) backed by at least 2 Signals (`ARGUS_JUDGE_MIN_SIGNALS`; a single-Signal Narrative is skipped, starts no run and uses none of the run cap, and is judged once it gains a second Signal), that has no Score, or that changed materially (`changed_materially_at`, see `isMaterialJoin`) after its last one, busiest first. A Narrative that merely gained a Signal from a Source it already had is not re-judged, and a Rubric edit does not re-judge old Narratives; each Score names the Rubric version it used. The prompt carries the Rubric as read at call time and the Narrative's newest 15 Signals as delimited untrusted data; the answer must be exactly `{"scores": {<each dimension>: number}, "rationale": string}`, numbers are clamped to 0 to 10, and anything else is refused, logged and not stored (not retried until the Narrative changes again; an over-budget run is treated the same, but any other failure, such as a missing claude, expired auth, the network or a timeout, is transient: the Narrative stays eligible, the run still counts against the caps below, and 3 in a row end the pass early with one log line). The run is a Brain run like a Spec draft: no tools, isolation flags, `--max-budget-usd` $0.10, 5 minute timeout, an in-flight `brain_runs` row (`proposal_id` 0, `narrative_id` set) opened before the spawn, cost recorded on return, and `--dry-run` spawns nothing. Its own caps: 10 Narratives per pass, and 300 runs or $2 in any rolling 24 hours (`ARGUS_JUDGE_MAX_PER_PASS`, `ARGUS_JUDGE_MAX_RUNS_PER_DAY`, `ARGUS_JUDGE_MAX_DAILY_USD`); a rate limit ends the pass. The judge never writes a Proposal (Proposal expiry counts from the latest `status_history.at` into the current status).

The propose pass (`packages/core/src/propose.ts`, right after each judge pass on the same 30 minute tick) turns Scores into Proposals. A Narrative is offered when its latest Score's buildability is at least the Rubric's gate as it is now (default 5, on the 0 to 10 scale), it has had a Signal within 72 hours, and it has never had a Proposal (a unique index on `proposals.narrative_id`, so a dismissed Proposal still counts); best weighted total first. The run is a Brain run on the `propose` route (sonnet, `claude -p` on the subscription, WebSearch and WebFetch only, isolation flags, `--max-budget-usd` $1, 15 minute timeout, an in-flight `brain_runs` row with `proposal_id` 0 and the `narrative_id` before the spawn, cost recorded on return and then attached to the Proposal it made, `--dry-run` spawns nothing). Its prompt carries the Narrative's newest 15 Signals (with their links) and its Score as delimited untrusted data. The answer must be exactly `{"name", "ticker", "tech", "interaction", "whyNow", "reason", "description", "evidence"}` and nothing else (`reason` and `interaction`, what the visitor does, are stored as `proposals.reason` and `proposals.interaction`, ticket 17): one-line strings within fixed lengths, an `interaction` that contains a user-action verb (otherwise refused as display-only or action-less, and given the same one repair try as a count or length miss), a ticker of 2 to 10 upper-case letters and digits, and 3 to 5 distinct http(s) links that pass `normalizeEvidenceLinks`. Anything else is refused, logged and not stored (nothing is coerced), and the Narrative is not tried again until it is scored again; an over-budget run is treated the same, any other failure is transient (3 in a row end the pass). The Proposal is made by `Datastore.createResearchProposal`, the one creation path (status `new`, system actor, history entry at now, which expiry counts from), and `proposePendingNarratives` takes an `onCreated` callback, the one hook for a notification. The list row (the card's compact form, "Soft Rows" design) shows the name, ticker and status, the Narrative summary, the Narrative's latest Score total with thin horizontal bars per dimension, the collision pills, the Narrative's age and the actions; the Tech one-liner, "why now", the description and the evidence links live on the Proposal's detail page (`/proposals/:id`), which the row links to.

Collision checks (`collision.ts`): before a Proposal is created, its name and ticker are searched on DexScreener (`DexScreenerClient.search`, two requests; a pair with the same ticker, or the same name ignoring case and punctuation, is a collision) and the slug of its name (the repo name the Build uses) on GitHub's public search (`name in:name fork:true`, `per_page=100`, one request, so forks count; ADR 0008's unauthenticated 10 per minute; a repo of exactly that name under any owner is a collision). Both go through the bounded `timedFetchText`, the whole check is cut off at 15 s, and each side backs off after a failure like `BackoffSource` (doubling wait, honours Retry-After; while waiting it sends nothing). Each result is stored on the Proposal (`proposals.collision_checks`, JSON) as `clear`, `collides` or `unknown` with a detail line, its source and the time of the check. `clear` needs every request of that side to have answered with no match, and a DexScreener `clear` means no match in the pairs the search returned, not on the whole chain; a timeout, rate limit, error, unreadable answer or a backoff wait is `unknown`, never `clear`, and a Proposal that was never checked (hand-entered, or the checker itself threw) shows "not checked". A colliding name is retried once: one more propose run whose prompt names the rejected name and ticker, under the same limits (daily run count, research budget) and with its own brain run; both runs become the Proposal's cost. If the retry is refused by a cap, fails or is unusable the first answer is kept; if the retry's name still collides it is stored with the flag. A colliding Proposal is never hidden. The card (list and detail) shows both results. More ways to `unknown`: DexScreener's search answer must carry a `pairs` array (`pairs: []` is the no-match answer; a missing or null one is an error), GitHub's must carry `total_count` and `incomplete_results: false`, and with no exact match on the first page of 100 and `total_count` above it the check is `unknown` (search matches loosely, so an exact-name repo may sit further down; this makes short, common names often unknown rather than falsely clear), and a name or ticker over 100 or 30 characters is not searched at all. DexScreener search keeps pairs on any chain whatever their address looks like (SUI, TON). The test run points `ARGUS_DEXSCREENER_SEARCH_URL` and `ARGUS_GITHUB_SEARCH_URL` at a dead loopback port, so a worker a test spawns stores `unknown`.

Load limits, all in code and none raised silently:

- **30 new Proposals per rolling 24 hours** (`MAX_NEW_PROPOSALS_PER_DAY`; raised from 10 by the Operator on 2026-11-06). `createResearchProposal` refuses the 31st inside its own transaction; `ARGUS_PROPOSE_MAX_NEW_PER_DAY` can only lower it (above 30 is an error). Hand-entered Proposals are not counted. The pass also stops before spawning when the cap is reached, so no run is paid for that cannot be used.
- **Migrated examples** (ticket 22): the prompt carries a second untrusted block of the most recently migrated pump.fun tokens read from the Study tables (`ARGUS_PROPOSE_MIGRATED_EXAMPLES`, default 10, hard maximum 20, 0 = off; no network). They are hints: `migrated_at` is PumpPortal receipt time and not bot-filtered. With none, the block is left out. Ticket 09's Playbook replaces this source.
- **Operator angle requests (meta redesign tickets 11 and 16)**: at most 10 in a rolling 24 hours that are waiting, running or done (`DEFAULT_MEME_ANGLE_PER_DAY`; `ARGUS_MEME_ANGLE_MAX_PER_DAY` can only lower it; ceiling `MAX_MEME_ANGLE_PER_DAY` 10; a refused, failed or capped request does not spend it) and at most 3 times that many of any outcome (`ANGLE_ATTEMPT_CAP_FACTOR`), one waiting at a time, counted at request time by `Datastore.requestMemeAngle`. Each run is also a `meme-ideas` run in the research budget, but not in the regular 24-a-day meme cap: angle runs have their own allowance of 10 runs that file Proposals in a rolling 24 hours (`DEFAULT_ANGLE_DAILY_MEME_RUNS`, ceiling `MAX_ANGLE_DAILY_MEME_RUNS` 10; tickets 12 and 16; one per filed trio, counted through the Proposal the run is attached to), told apart by `brain_runs.angle`, and automatic runs cannot use it. A refused run does not spend the allowance, but every angle run counts toward a hard cap of 3 times it (30 runs a day, refusals and retries included). `dailyMemeRunLimit` and `angleAttemptCap` in `meme/pass.ts` and `meme/angle.ts` are the one place that says the limits; a capped request says "angle allowance of 10" or "angle attempt cap of 30" where an automatic run says "daily cap of 24".
- **Per pass and per day**: 3 Narratives per pass and 45 propose runs per rolling 24 hours (so 30 new Proposals a day stay reachable when some runs are refused or fail), refused and failed runs included (`ARGUS_PROPOSE_MAX_PER_PASS`, `ARGUS_PROPOSE_MAX_RUNS_PER_DAY`); per run, the route's `--max-budget-usd` of $1.
- **Research share (judge plus propose): one rolling 24 hour budget of Est. usage**, `ARGUS_DAILY_QUOTA_USD` x `ARGUS_RESEARCH_SHARE` (defaults $20 x 0.3 = $6; the quota must be a positive number and the share in (0, 1], else an error). Both passes check it before every run, summing the `total_cost_usd` of every judge and propose run started in the last 24 hours; at or above the budget they stop (`research-cap`) and wait until older runs age out. A run that ends without printing a result (killed by its wall clock or a shutdown, or left in flight by a dead worker) reports $0, so for the budget it is charged at its route's per-run cap (judge $0.10, propose $1), a ceiling on what it can have used; the reported cost is kept separately (`brain_runs.total_cost_usd`), and a plain `failed` run, which is also what a claude that never started looks like, is charged only what it reported. A run in progress may overshoot by up to its own per-run cap. The judge's own $2 a day leaves the propose pass at least $4 of the default. This approximates "about 30% of the daily subscription quota" only as well as the quota figure does: the plan's real limits are not readable by argus (section 13), so `ARGUS_DAILY_QUOTA_USD` is the Operator's estimate of the Est. usage the plan allows per day and the $20 default is a placeholder to be replaced once real usage is measured. Builds are not research and have no research budget, but they count toward the **daily quota** itself, and that quota (rolling 24 h) gates the start of a Build: when the daily figure is at or above it, the Build waits and starts on its own once older runs age out. The daily figure (`dailyUsedUsd`) is every subscription run in the 24 hours (research and Spec runs as charged above, and every Build dollar, every attempt, exact or estimated). A Build's dollars come from its run row (`brain_runs.total_cost_usd`): claude's own result when it prints one (`cost_source` `exact`); otherwise, for a run killed or crashed without a result, the usage of the `stream-json` turns priced from the one price table (`model-prices.ts`; the stream's output counts are start-of-message stubs, so output is taken from the content's size) while claude ran, or, with none recoverable, its minutes times the average $/min of the last 10 Builds (default $25 over 240 min), never 0 and never above what the Build's cap leaves (`estimated`). Both attempts of a Build sum against its $25 cap (the retry gets the remainder, or none under $1). Spec drafts that were killed, timed out or cancelled (Undo shortlist) are recorded at their route's cap, estimated. The War Room shows exact, estimated and unknown costs apart. The War Room's home page shows the usage, the budget, the share of the assumed quota and the new-Proposal count (`/api/research`).

Playbook block (phase 3a): the judge and propose prompts carry, besides the Rubric, an approved-lessons block that argus renders at call time (judge: lessons on Narrative and Tech; propose: lessons on Identity and Tech). It holds at most 10 active lessons, sanitised like other prompt data and framed as hints that never override the output contract, and each Score and Proposal records the Playbook version next to the Rubric version. A Playbook change never re-judges old Narratives.

Study caps sit beside the research share and are separate from it: the planned `study` task (not built, section 5) would have its own rolling-24h run cap (about 100 runs a day) and per-run budget, and today's Study has a daily capture cap (`MAX_CAPTURE_RUNS_PER_DAY`), plus a daily X capture cap (about 200) and a daily Helius credit cap, all in code and lowerable only by configuration (invariant 3). Claude runs stay on the subscription; only real cash (Helius, Cloudflare Browser Rendering and the like) counts against the $100/mo.

Score scale: each dimension is scored 0 to 10 (`RUBRIC_MAX_SCORE`), and the default buildability gate is 5 (`SEED_GATE_MIN_SCORE`), both in `packages/core/src/rubric.ts`; the `judge` task follows them.

## 8. War Room

Localhost only, single Operator, no auth in v1.

**Proposal card**: Narrative summary (2 lines), Tech one-liner, "why now", Score bars per Rubric dimension, 3 to 5 evidence links, collision checks (DexScreener by name and ticker, GitHub by repo name), proposed name and ticker, Narrative age, agent cost so far, Proposal status. The War Room shows these across two views: the list row carries the compact subset (see the propose pass above) and the detail page carries every field, including Tech one-liner, "why now" and the evidence links.

**Details view**: full evidence, Score history, Signals, brain run log and costs, Spec, Build log and preview link.

**Spec editor**: a textarea over `spec.md` plus "ask the agent to revise" (each turn is `claude -p --resume <session_id>` against the Spec session).

**Actions**: shortlist (after a confirmation modal, since it starts a paid Spec run), undo shortlist (while shortlisted or spec-drafted), approve, dismiss (with a reason), Launch (opens newpairspam with the form prefilled from name, ticker, description, logo and preview link), mark launched (records the mint). The Launch button is enabled only in `built`.

**Study page** (phase 3a): Study health (tokens seen, in population, Snapshots, labelled, missed creates, gaps), bucket counts (control, organic migrator, bot-driven migrator, Fast flag, with the Fast by bot-driven cross-tab), Study spend (runs against cap, Est. usage as information, Helius credits against the Free budget, X captures against cap), and the Operator's own Launches with their outcomes.

**Weekly Playbook review** (phase 3a): a page listing suggested lessons and suggested Rubric changes (shown as a diff, applied through the Rubric editor and versioning) with their evidence: Cases counted, organic against control rate with weights, lift, Cohorts held in. The Operator approves, edits, rejects or retires each. Separate sections show dismissal reasons and the Operator's own Launches. Confounder findings (Presence, Launch mechanics, Timing) are shown but never approved into a prompt.

**Telegram**: one bot, one Team chat, notifications only (no commands, no reply-to-approve): new Proposal cards, build start, build done, build failed.

## 9. Stack and repo layout

pnpm TypeScript monorepo. Conventions follow the user's global setup: TypeScript 7 native compiler (`typescript` 7.x pinned to an exact version), typecheck script `tsc --noEmit --checkers 1`, vitest, incremental build info under `node_modules/.cache/` only if warm runs are measurably faster. Type-check and test once before committing.

```
argus/
  apps/
    worker/        long-running process: ingest, scheduler, brain and build children, Telegram
    warroom/       Nuxt 4 + Nuxt UI 4
  packages/
    core/          datastore, sources, brain (interface + backends), build runner, rubric
  .claude/skills/  judge, propose, spec (ClaudeCodeBrain skills)
  .data/           gitignored: argus.db, proposals/<id>/{spec.md,build.log}, study capture artefacts (saved X HTML and screenshots)
  docs/  GLOSSARY.md  .scratch/
```

The Study's tables (tokens seen, Snapshots, labels, Cases, Cohorts, Playbook lessons, Study runs) live in the same SQLite database. The dedicated Chrome user-data directory for X capture (`ARGUS_CHROME_DIR`, default `~/.local/share/argus/chrome`) is outside the repo.

- Datastore: SQLite via `node:sqlite`, WAL so the worker writes while the War Room reads, additive idempotent migrations (`ensureColumn` pattern from helios).
- Specs are markdown files at `.data/proposals/<id>/spec.md`; the database stores path and hash.
- One long-running worker process (systemd user service or pm2) owns the state machine, the 5 min ingest tick, the 30 min brain tick, expiry and the Build queue. No cron. Ticks are guarded against re-entrancy (helios `reentrant.ts`).
- Brain and Build children are spawned by the worker, not by the War Room. The War Room talks to the worker through the datastore (command rows such as "approve requested") so there is one writer of state transitions.
- Token assets: name, ticker and description come from the brain `propose` task with the collision check. The logo is a template SVG placeholder in v1.
- Build outputs: `~/code/<slug>` locally, a private GitHub repo under the personal owner, preview at `<slug>.workers.dev`. Domains are bought by the Operator, not argus.

## 10. Invariants

Carried from the superseded launch pipeline plan (section 3) and adapted:

1. **Keys never in the repo.** Claude OAuth token, Telegram token, the optional Anthropic API key (read only by the worker's ApiBrain, never passed to a child), GitHub, Cloudflare and Helius (`HELIUS_API_KEY`) credentials live in git-ignored `.env` or the OS secret store. Agents never print them. The dedicated Chrome directory used for X capture holds the Argus X account's cookies: it stays outside git and outside shared backups, mode 700. Build agents run in a rootless podman container (ADR 0005) whose environment is an allowlist: the only credential inside is the separate Build token (`CLAUDE_CODE_OAUTH_TOKEN`, inference only, `agent` container only); no GitHub, Cloudflare, npm or brain credential is mounted or passed, and the container's only network path is the allowlisted egress proxy. There is no uncontained Build mode.
2. **Dry-run on anything that spends.** Brain runs, Builds, repo creation and deploys all support `--dry-run` (log the command, spawn nothing). Exercised before real runs.
3. **Spend caps in code.** Per brain run `--max-budget-usd`; a daily research share of about 30% of the subscription; per-Build budget and the 4 h wall clock; and, for the optional API fallback, a daily cap in real dollars (`MAX_API_DAILY_USD`) that configuration can only lower; for the Study, its own run cap, the daily X capture cap and the Helius credit budget (daily cap), also in code. Hitting a cap fails the run; it is never silently raised.
4. **Disclosure on every Build.** The template carries a footer stating the project was created by argus and the creator may sell; the Build Runner verifies it exists before `built`.
5. **Argus never deploys tokens.** No wallet, no keys for chains, no transactions. Read-only chain reads (Helius) and public-API reads (PumpPortal events, DexScreener) are allowed. Launch is manual in newpairspam (ADR 0002, amended).
6. **No fake organic interest.** Argus does no posting, botting or promotion. The Argus X account never posts, likes, follows or messages; it is only logged in so the capture can read.

## 11. Ported from helios, and not

Ported (copied and adapted, not forked or shared as a package):

- `Source` interface and the RSS adapter (`packages/core/src/sources/rss.ts`), including its time-bounded fetch.
- PumpPortal adapter (`sources/pumpportal-bonding.ts`) and trends feeds (`trends-feeds.ts`).
- Clustering and embedding approach (`clustering.ts`, `embedding.ts`) for Narratives, as `packages/core/src/narratives.ts`; the embedder is an in-process semantic model (`gte-small`, `apps/worker/src/semantic-embedder.ts`, ADR 0007) rather than helios's lexical `HashingEmbedder` (ADR 0006). The worker clusters after each ingest tick; the War Room lists Narratives at `/narratives`. The Operator's Verdict on a Narrative (War Room ticket 19, GLOSSARY: Verdict) is the append-only table `narrative_verdicts` (insert-only `addNarrativeVerdict` on the War Room's Datastore view, written by `POST /api/narratives/:id/verdict`, which reads the latest Score id and Rubric version from the store), exported read-only with the Scores at `GET /api/narrative-verdicts`; no judge or Rubric reads it. Launchpad creates and bonds are not embedded: they are grouped by the token's name and ticker keys, with a size bound on every Narrative (`launchpad-cluster.ts`, ADR 0007 amendment of 2026-11-14). A DexScreener token may join a news Narrative or a launchpad one that holds its name, but when it matches neither it starts a launchpad-kind Narrative keyed by its name and ticker, never a news one (`placeDexscreenerToken`, ADR 0007 amendment of 2026-11-16); the judge, propose and news-meme selectors share one `HAS_NEWS_SIGNAL` guard, so a news Narrative needs a market Signal and a news Signal (ADR 0011 amendment of 2026-11-16).
- Datastore pattern (`datastore.ts` head): `node:sqlite`, WAL, additive `ensureColumn` migrations, single file shared by worker and War Room.
- Worker tick loop with the re-entrancy guard (`apps/worker/src/reentrant.ts`, not in `packages/core`).
- War Room layout ideas (`docs/design/war-room.md`): scan, read in place, act, without leaving the page.
- The Rubric and feedback labels idea (dismiss as negative, launch as positive).

Not ported:

- The helios X cookie scraper and burner-account machinery (helios ADR-0002 territory). Argus's X capture is a different thing: a dedicated, read-only, logged-in browser on the dedicated Argus X account, run as a Playwright script (ADR 0009), not the helios cookie scraper.
- Grok / OpenRouter judge (replaced by the Brain).
- The launcher and launch profiles (newpairspam's job).
- Helios `Event` naming; argus uses Narrative.

## 12. Phases

Status as of 2026-11-07 (the journal `.scratch/cos.md` is the live record):

- **Phase 1**: tickets 01-20 done, including containment (15-17, ADR 0005). Open: ticket 10 (acceptance run) and the second acceptance point of ticket 12, both needing the Operator present and the Build token, which is not yet minted. No real Build has run; Builds are exercised only by fakes, `--dry-run`, `verify:boot` and `verify:contain`.
- **Phase 2**: all tickets done except P2-14 (the 48 h acceptance run) and P2-17 (PumpPortal market evidence, ticket written, not built, waits for P2-14). The acceptance run is live as a research-only run with the API fallback off; it was restarted after a lid-close suspend and now runs under a systemd sleep lock, with a planned end on 2026-11-08. Still open inside it: the forced-exhaustion fallback check and the card-to-launched check. Also merged: the Activity page (P2-16), Atom feeds (P2-15), the Soft Rows War Room redesign with Narratives sort and filter (ticket 18). A Proposals sort and filter ticket is in progress.
- **Phase 3**: specified (`.scratch/phase-3-feedback/spec.md`); slice 1 (measurements) done, the rest not started.

**Phase 1 - Build path end to end with a hand-entered Proposal.**
Scope: monorepo skeleton and tooling; datastore with Proposal, Spec, brain-run and Build tables; Proposal lifecycle module with `approve()`; War Room list, Proposal card and details view, Spec editor (textarea plus revise via `--resume`); `argus-build-template` repo (Workers web app, `/implement-spec` skill, lint, CI, disclosure footer); Build Runner (clone, `gh repo create`, spawn, stream-json log, retry, build-failed with `session_id`, FIFO queue, 4 h cap); `wrangler deploy` preview; cost capture from `total_cost_usd`; Brain interface with ClaudeCodeBrain only. Telegram is phase 2.
Definition of done: the Operator enters a Proposal by hand, shortlists it, edits the Spec, approves, and without further input ends with a private GitHub repo, a working `<slug>.workers.dev` preview, status `built`, and agent cost on the card; a forced failure produces one retry then `build-failed` with a resumable `session_id`; an on-chain Spec ends in `needs-human`; a dry-run mode exists; budget and wall-clock caps are tested.

**Phase 2 - Research port.**
Scope: Sources (RSS, Google Trends, PumpPortal, DexScreener, GitHub trending), Signal dedupe and clustering into Narratives, Rubric storage and War Room editor, brain `judge` and `propose` with the ApiBrain fallback and routing config, 30 min delta pass with the 30 per day cap, collision checks, Telegram new-Proposal notifications, expiry (48 h and 7 d), re-score with history, Launch handoff and mark launched.
Definition of done: left running for 48 h unattended, argus produces at most 30 Proposals per day from live Sources, every card shows all fields from section 8, stale Proposals close on schedule, a forced subscription exhaustion switches judge/propose to the API and builds wait, and a Proposal can go from card to marked launched using only the War Room and newpairspam.

**Phase 3a - The Study and the Playbook.**
Scope: the Study pipeline (section 2): Snapshots at fixed ages (metadata and website 60 s, X 5 min), chain labels at 24h and 7d, Organic migration bot filter and Fast flag (migrated within 60 s), Cases and Cohorts, blind `study` runs inside their own caps, lesson aggregation, the Playbook with the weekly War Room review, approved lessons rendered into the judge and propose prompts (Playbook version stored), Rubric changes through Rubric versioning, and read-only own-launch tracking that closes `launched` Proposals at 7d. Dismissal reasons get their own review section.
Definition of done (all of): the Study ran 14 days unattended; Snapshots were taken daily and chain labels written at 24h and 7d; at least 50 migrator Cases and 50 control Cases have final labels, produced within 100 Study runs a day; the first Playbook review took place in the War Room; at least one approved lesson is in the live judge or propose prompt, visible as a Playbook version on a stored Score or Proposal.

**Phase 3b - The auto-ladder.**
Scope: a backtest harness, then auto-spec for top-scored Proposals and auto-approve above a Score threshold through the same `approve(store, id, "system", reason)`, each as a separate ticket behind an off-by-default config switch with a daily cap in code.
Gate (3b may start only when it passes): the brain's own score, computed on a later Cohort blind to labels, puts a top decile whose organic migration rate is at least 3 times that Cohort's population base rate (with sampling weights, not the oversampled 1:1 rate), in two consecutive later Cohorts (consecutive calendar weeks). Auto-launch through a newpairspam API is explicitly out of scope.

## 13. Open questions

- Plan limits and the research share. The plan is Max 5x (Operator, 2026-11-06) and `ARGUS_DAILY_QUOTA_USD` stays at $20 (research $6 a day) as an estimate; argus cannot read the plan's real limits. Revisit using the measured usage of the P2-14 run (so far roughly $0.3 to $0.9 per 6 h; the judge's 150 runs a day cap binds first).
- Whether `claude -p` keeps drawing from the subscription: a support article from October 2026 says yes; re-check before relying on it, and keep ApiBrain working. Unresolved.
- API fallback policy (ticket 12): off by default (`ARGUS_API_FALLBACK=1`); triggered only by a rate-limited `claude -p` run; held until claude's reported reset (at most 6 h), else 15 minutes; a daily cap of $0.50 real money, lowerable but never raisable by configuration. The Operator keeps it off until after the P2-14 run, then decides on and sizes it from measured usage.
- Real-claude paths that only fakes cover: budget-exceeded, 429 and rejected rate-limit handling. First real Builds wait for the Build token.
- Narrative clustering margin: the 0.90 threshold of the in-process `gte-small` embedder holds on a fresh holdout but the margin is thin; re-measure on a larger, later-week sample before changing any feed or model.
- PumpPortal market evidence (P2-17): decided as B+C, not built, after P2-14.
- Phase 3, open after the slice 1 measurements and the Operator's review (`.scratch/phase-3-feedback/spec.md` section 14 has the detail):
  - Bot-filter thresholds are hypotheses, validated on no pump.fun migrators; they are calibrated on post-migration crash and re-checked on a later Cohort.
  - Which crash measure to use (DexScreener `priceChange` windows first) and how the brain's cheap score for the 3b gate is computed (decided in the first 3b ticket).
  - The X-capture selection rule under the 200 a day cap, headless against headed Playwright, and the lock and challenge signals (X capture spike).
  - The share of website Snapshots that are an empty app shell, which decides whether Cloudflare Browser Rendering is added for flagged sites (Operator approval first).
  - Helius Free against the $49 Developer plan: decided by measured credits (the Operator is asked before moving).
  - Fewer than expected organic migrators with links: 50 Cases in 14 days is the floor, not a result.
- Resolved: the newpairspam prefill mechanism (P2-13) is built and merged in both repos.
