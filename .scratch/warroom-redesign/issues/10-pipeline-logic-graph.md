# 10: War Room: a "How it works" page that draws the pipeline logic as a graph and cannot go stale
**Model:** slice a sonnet / high, slices b and c sonnet / med. Slice a sets the data model, the sync test and the generated docs, and a wrong model there costs every later change; b is SQL counts over tables that already exist, c is a side panel that reads the same graph.

**What to build:** the Operator wants "a graphic way of seeing how the logic works ... so I can see what I can improve, change, remove ... updated anytime the logic changes. High level, not fully detailed." Today the only picture is three hand-drawn mermaid blocks in `docs/architecture.md` (system overview `:13`, Proposal lifecycle `:70`, Build Runner `:135`); the Operator reads the War Room, not that file, and nothing makes them follow the code. This ticket adds a War Room page `/pipeline`, nav label "How it works", that draws the pipeline from ONE typed graph definition in code, shows live last-24 h numbers on it, and opens a panel per node. The same definition generates the `docs/architecture.md` diagrams, and a test fails when the code gains a Source, stage, cap or gate the graph lacks.

Status: done

**Blocked by:** none. Slices are mergeable on their own, in order a, b, c (b and c need a's graph). See Interplay.

## Decided by the user (2026-11-14), not to be reopened

- Route `/pipeline`, nav label "How it works" (`apps/warroom/app/app.vue`, `NAV`). Plain Vue + SVG in fixed columns, Soft Cards style (`.scratch/warroom-redesign/figma/README.md`, item 3), no graph library, motion with Vue built-ins only (`<TransitionGroup>`, `<Transition>`).
- About 12 nodes: Sources, Signals, Narratives, Judge, Proposals, Shortlist, Spec, Approve, Build, Preview, plus side nodes Meta, Beta finder, Study. Each has a status: `on`, `off` or `context-only`.
- One typed graph definition is the single source of truth. Gate and cap values are imported from the real constants, never retyped.
- A sync test fails when the code gains a Source, pipeline stage or gate/cap that the graph lacks.
- The `docs/architecture.md` diagrams are generated from that file, with a check that fails when they are stale.
- v1 shows live data: per edge, last-24 h counts; per node, Claude spend per day from `brain_runs`. A click on a node opens a side panel: what it does, its rules with values, linked ADRs and tickets, the code file.

## Decided by the ticket writer, the user can overrule

- **Where:** `packages/core/src/pipeline-graph.ts` (types, the `PIPELINE` value, `pipelineGaps()`), exported from `packages/core/src/index.ts`; tests beside it. Pure data plus imports of constants, no I/O. The War Room never imports `@argus/core` in client code (every current use is in `server/`, and the package index pulls in `node:sqlite`), so the page reads a resolved copy from a new route `apps/warroom/server/api/pipeline.get.ts`, which evaluates each rule's `ref()` on the server. That also keeps the rule values the code's, not a copy.
- **Shape:** `nodes[]` each with `id`, `label`, `column`, `row`, `status`, `what` (one plain sentence), `rules[]` (`{ label, ref: () => number | string, unit }`: the value is a function over the real constant, so it cannot be typed in), `adrs[]`, `tickets[]`, `files[]`, `worker?` (the tick that runs it) and `brainTask?`; `edges[]` with `id`, `from`, `to`, `label`, `metric?` (the slice-b key). Nodes the diagrams need but the page does not (Operator, Telegram, Launch handoff, Playbook) carry `onPage: false`, so the generated system overview keeps what the hand-drawn one says.
- **Sources** are `sources[]` on the Sources node (one chip each, status `context-only` or `on`), not twelve more nodes: RSS catalog, Google Trends, GitHub trending are `context-only` (ADR 0011), PumpPortal and DexScreener `on`. Beta finder is `off` (viral-sources/04: library and backtest only, slices 3-4 paused); the node says so and links the ticket.
- **Intervals into core:** `INGEST_TICK_MS`, `JUDGE_TICK_MS` and `STUDY_TICK_MS` are private constants in `apps/worker/src/main.ts`; move them to core and export them (as `BUILD_TICK_MS` already is, `build-refusal.ts:7`), so the graph can import them. `SEED_GATE_MIN_SCORE` is a private `const` in `rubric.ts:63`; export it too. The Meta interval is `metaIntervalMinutes(env)` / `DEFAULT_META_INTERVAL_MINUTES` (`meta/config.ts:65`).
- **Docs:** generate the system overview (`:13`) and the lifecycle state diagram (`:70`). The lifecycle diagram is drawn from `TRANSITIONS` (`packages/core/src/lifecycle.ts:45`) via the same generator, not copied into the graph file, because that table is already the truth for it. The Build Runner sequence diagram (`:135`) stays hand-written: it is a call sequence with retry branches, the level of detail this graph leaves out on purpose, and the Build node's panel links to section 4 instead. A one-line comment above it says it is not generated.
- **Live gate:** the buildability gate is editable data (`store.getRubric().gateMinScore`, `rubric.ts:148`; `SEED_GATE_MIN_SCORE` is only the seed, architecture section 7). The graph's rule uses the seed as `ref()`; the API route overrides it with the stored Rubric's value and the page shows the version.

## What is there today (checked 2026-11-14)

- Stages run as guarded ticks in `apps/worker/src/main.ts`: `tick` (commands, clean-ups, expiry, Telegram, Spec draft and revise), `buildTick`, `ingestTick` (poll Sources, then cluster into Narratives), `judgeTick`, `proposeTick` (both through `runResearchTick`), `studyTick`, `metaTick`, `metaSummaryTick`.
- Sources are registered in two places: the RSS list from `config/rss-feeds.json` via `loadRssSources`, and `standingSources` in `main.ts` (`GoogleTrendsSource`, `DexScreenerTrendingSource`, `GitHubTrendingSource`, then `PumpPortalSource` in the daemon only). Their class is declared in `packages/core/src/sources/source-class.ts` (`SOURCE_CLASS`, `SOURCE_CLASS_PREFIX`); `source-class.test.ts` already proves each registered Source has a class, but nothing ties that to a picture.
- Caps and gates, all exported constants or config objects: `MAX_NEW_PROPOSALS_PER_DAY` (30, `datastore.ts:226`); `DEFAULT_JUDGE_CONFIG` (`judge.ts:132`: `windowHours` 72, `maxPerPass` 10, `maxRunsPerDay` 300, `minSignals` 2, `maxDailyUsd` 2); `DEFAULT_PROPOSE_CONFIG` (`propose.ts:257`: `maxPerPass` 3, `maxRunsPerDay` 45, `maxNewPerDay`, `migratedExamples`); `DEFAULT_RESEARCH_BUDGET_CONFIG` (`research-budget.ts`: $20 x 0.3 = $6); `EXPIRY_MS` (`expiry.ts:7`: `new` 48 h, `shortlisted` 7 d); `DEFAULT_ROUTING` (`brain.ts:141`: model and `maxBudgetUsd` per task, Build $25 and 240 min); `MAX_CAPTURE_RUNS_PER_DAY` and `STUDY_CAPTURE_RULE` (`study/config.ts`); `META_RULE`, `META_WINDOWS` (`meta/config.ts`); the market-Source rule `MARKET_SOURCE_IDS`.
- The brain tasks are `judge | propose | spec | build | meta-summary` (`brain.ts:8`). Architecture section 5 still lists a `study` task that `BrainTask` does not have (Open question 3).
- Data for slice b already exists: `signals.ingested_at` and `Datastore.sourceHealth()` (`signals24h` per Source), `narratives.created_at`, `scores.created_at` (one row per judge run that scored), `proposals.created_at` and `researchProposalsSince`, `status_history` (`to_status`, `at`, `actor`) for shortlist, spec, approve and built, `brain_runs` (`task`, `backend`, `total_cost_usd`, `created_at`) with `researchSpendSince` and `apiSpendSince`, `study_tokens` (`first_seen_at`, creates), `meta_runs`. Pages poll with `useFetch` plus a 10 s `setInterval` (`activity.vue`); the new page does the same.
- `scripts/warroom-pages.mjs` (`pageRoutes`) lists pages for `verify:boot`; the new page must answer 200 there with no change to that script.

## The three slices

**(a) Graph definition, static page, sync test, generated docs.**
`pipeline-graph.ts` and `pipeline.get.ts`; `apps/warroom/app/pages/pipeline.vue` and a `PipelineGraph.vue` that draws columns left to right (Sources, Signals, Narratives, Judge, Proposals, Shortlist, Spec, Approve, Build, Preview; Meta, Beta finder, Study as a row beneath), nodes as Soft Cards, edges as SVG paths from a pure layout helper (`apps/warroom/app/utils/pipeline-layout.ts`, tested from `apps/warroom/server/test/`, the only place the vitest include reaches). Status shows as a pill (`on`, `off`, `context-only`); an `off` node is drawn muted. Node and edge labels are text, no `v-html`. The nav item. `scripts/gen-architecture.mjs` with a write mode (`pnpm docs:graph`) and the stale check below.

*The sync test* (`packages/core/src/pipeline-graph.test.ts`, fast tier) builds a registry from the code and passes it to `pipelineGaps(graph, registry)`, which returns every gap as a sentence. It enumerates:
1. **Sources:** every key of `SOURCE_CLASS` and `SOURCE_CLASS_PREFIX`, and every non-test file in `packages/core/src/sources/` that declares `implements Source`, plus every `new <X>Source(` in `apps/worker/src/main.ts`. Each must appear in `sources[]` with the same class.
2. **Stages:** every `const <name>Tick = reentrant(` in `apps/worker/src/main.ts` and every key of `DEFAULT_ROUTING`. Each tick name must be the `worker` of some node and each task the `brainTask` of some node.
3. **Gates and caps:** every key of `DEFAULT_JUDGE_CONFIG`, `DEFAULT_PROPOSE_CONFIG`, `DEFAULT_RESEARCH_BUDGET_CONFIG`, `META_RULE`, `STUDY_CAPTURE_RULE`, every status in `EXPIRY_MS`, and `MAX_NEW_PROPOSALS_PER_DAY`, `SEED_GATE_MIN_SCORE`, `MAX_CAPTURE_RUNS_PER_DAY`. Each must be the `ref` of a rule, or be on an explicit `LEFT_OUT` list in the test with a reason (for example `maxConsecutiveFailures`, a circuit breaker below the level of "high level"). New keys therefore fail until someone decides.
4. **Shape:** every edge names two existing nodes; no node is unreachable; every `adrs[]` entry is a file in `docs/adr/` and every `tickets[]` and `files[]` entry exists on disk.

*The docs check* (`packages/core/src/pipeline-docs.test.ts`) renders the two diagrams and compares them to the fenced blocks between `<!-- generated:pipeline-overview -->` and `<!-- generated:pipeline-lifecycle -->` markers in `docs/architecture.md`; a difference fails with "run `pnpm docs:graph`". It runs inside `pnpm check`, so a stale diagram cannot be committed on a full check.

**(b) Live 24 h counts and spend.**
`apps/warroom/server/api/pipeline-live.get.ts` returns, for the rolling 24 h: per edge a count keyed by the edge's `metric` (creates seen and Signals ingested; Narratives created; Narratives judged and how many passed the gate; Proposals created; shortlisted; spec-drafted; approved; built or build-failed), and per node `spendUsd` (Est. usage, `backend != 'api'`) and `runs` from `brain_runs` by `task` (`judge`, `propose`, `spec`, `build`, `meta-summary` to the node that owns it), with real API dollars kept in their own field and never added, as `research.get.ts` does. Queries go in the datastore as one read method, tested with an in-memory store. The page overlays counts on the edges and spend on the nodes, refreshes on the 10 s poll, and animates a changed number with a Vue `<Transition>`; a failed fetch leaves the static graph with a one-line "live numbers unavailable".

**(c) Node detail panel.**
Clicking (or Enter on) a node opens a side panel (a `<Transition>` slide, focus moved in, Escape and a close button return it): the `what` sentence, its status and why, its rules with the real values (the gate with its Rubric version, caps as "used / cap" where slice b has the used figure), linked ADRs and tickets as in-app text (no external link; paths shown as text, the repo has no GitHub issues), the code files, and that node's last-24 h spend. The panel reads the graph only; no new endpoint beyond slice b's.

## Acceptance

Slice a:
- [x] `PIPELINE` in `packages/core/src/pipeline-graph.ts` has the ten stage nodes and Meta, Beta finder and Study, each with a status; RSS catalog, Google Trends and GitHub trending are `context-only`, Beta finder is `off`.
- [x] Every number in a rule is a `ref()` over an imported constant or config object; no numeric literal stands for a gate or cap (a test fails on a literal value inside a `rules` entry, or the file has none).
- [x] The sync test enumerates items 1 to 4 above and passes on the current tree.
- [x] Stays in sync, proved two ways: `pipelineGaps()` is called in the test with a registry that adds a fake Source id, a fake `...Tick`, a fake brain task and a fake config key, and returns a gap for each; and in Comments, a recorded manual run: add a fake Source to `SOURCE_CLASS` (or a fake `new FooSource(` line in `main.ts`) without a graph node, run the test, see it fail naming the Source, revert.
- [x] `docs/architecture.md` system overview and lifecycle diagrams are generated between markers; editing the graph (or `TRANSITIONS`) without `pnpm docs:graph` fails `pipeline-docs.test.ts`; the Build Runner diagram is untouched and marked as not generated.
- [x] The generated overview still shows what the old one showed (Telegram, Launch handoff, the Study and Playbook path), via `onPage: false` nodes.
- [x] `/pipeline` is in the nav as "How it works", renders from `GET /api/pipeline` with no client import of `@argus/core`, and answers 200 in `verify:boot`.
- [x] The layout helper has a test (columns, rows, edge paths, no overlap); no `v-html`; no new dependency; no JS timer-driven animation.
- [x] `INGEST_TICK_MS`, `JUDGE_TICK_MS`, `STUDY_TICK_MS` live in core, and `main.ts` imports them.

Slice b:
- [x] `GET /api/pipeline-live` returns the per-edge counts and per-node spend above for a rolling 24 h; a test with an in-memory store seeds each table and checks every figure, including a row at 23 h 59 m (counted) and 24 h 01 m (not). (`packages/core/src/pipeline-live.test.ts`, first test: seven tables seeded at 23 h 59 m and 24 h 01 m; route in `apps/warroom/server/test/pipeline-live.test.ts`.)
- [x] Est. usage and real API dollars are separate fields; a `study` or unknown task row never crashes the route and is reported under "other". (`spendUsd` / `apiUsd`; `other` in both test files.)
- [x] The page shows the counts on the edges and spend on the nodes, refreshes on the poll, and degrades to the static graph when the route fails (tested at the route; browser-checked on the page).

Slice c:
- [x] A node opens a panel with `what`, status, rules with the real values, ADRs, tickets, files and spend; closing returns focus; Escape works; the panel text is escaped.
- [x] The buildability gate in the panel is the stored Rubric's value with its version, and equals the number on the Rubric page.

All slices:
- [x] Full `pnpm check` passes once on the committed clean tree, per slice.
- [x] Browser check by cos at 1240 px and a phone width: the graph reads left to right, nothing overlaps, `off` and `context-only` are told apart, the live numbers match `/activity` and `/api/research` for the same minute, the panel opens and closes by mouse and keyboard.

## Interplay

- **warroom-redesign/03, 04, 06** put Meta, a Meta page and a compact Research bar on the home; the Meta node here links to `/meta` as text and reuses their wording, it does not redraw them.
- **viral-sources/04** (Beta finder) is paused; the node is `off` and flips to `on` in the same commit that wires the finder, which the sync test (a new tick or task) will demand.
- **hardening/06** (run-time egress allowlist) may add fixed-host clients; they are not stages and are not drawn.
- GLOSSARY terms as the code says them: Signal, Source, Source class, Narrative, Proposal, Spec, Build, Operator, War Room, Meta, Beta, Study. The graph says "judged" and "proposed", not "scored" for the stage names.
- ADR 0002 is untouched: the graph draws the Launch handoff as outside argus.

## Commits

One commit per slice, after the full `pnpm check`. Subjects `War Room ticket 10a: <what changed>`, `10b`, `10c`; each body ends with `Ticket: .scratch/warroom-redesign/issues/10-pipeline-logic-graph.md` before the trailers. Boxes are ticked in the slice's commit only if the check does not stamp the tree afterwards, otherwise in a follow-up docs commit. A GLOSSARY.md line only if a new term appears (none expected). No `Closes #N`: this repo has no GitHub issues.

## Open questions

1. **Build Runner diagram:** left hand-written (see above). Alternative: generate it from a small step list on the Build node. Default: keep it hand-written.
2. **Edge for the market-Signal rule (ADR 0011):** drawn as a labelled gate on the Narratives to Judge edge ("needs a market Signal") with the rule's value from `MARKET_SOURCE_IDS`. Confirm that is the place the Operator expects it, not on the Signals node.
3. **Study spend:** `BrainTask` has no `study` (architecture section 5 says there is one, "about 100 runs a day"), so the Study node's spend is 0 and the Study captures count as plain code. Is the `study` task dead, or a gap in the docs? The node's rule list must say one or the other.
4. **Counts that need a definition:** "Narratives judged" is `scores` rows (a re-judged Narrative counts again) or distinct `narrative_id`? Default: distinct Narratives. "Creates" for the Sources edge is PumpPortal creates from `study_tokens.first_seen_at` beside Signals ingested; confirm the Operator wants both on one edge.
5. **Beta finder `off`:** there is no switch in code to read (it is a library and a backtest script, `scripts/backtest-beta.mjs`), so its status is a declared value in the graph, not derived. Accept that, or add a config flag as part of its own ticket?

## Comments

**2026-11-14, the Operator answered the five open questions, all as recommended:**
1. The Build Runner sequence diagram stays hand-written; it is marked "Not generated" in `docs/architecture.md` and the Build node points to section 4.
2. The ADR 0011 market-Signal rule is a labelled gate on the Narratives to Judge edge ("Needs a market Signal from", value from `MARKET_SOURCE_IDS`).
3. The Study is rule-based: `BrainTask` has no `study` (config `study_rule=v1`). The Study node is drawn with no Claude cost and no `brainTask`; `docs/architecture.md` section 5 (type, routing table, `study` paragraph, fallback line), and the matching sentences in sections 2 and 7, now say the `study` task is planned and not built.
4. For slice b: "judged" is distinct Narratives judged per 24 h; PumpPortal creates and Signals ingested are separate edges (edge metrics `creates_seen` on Sources to Study, `signals_ingested` on Sources to Signals).
5. Beta finder `off` is a declared value in the graph (with a status note linking ticket viral-sources/04) until a real switch exists.

**Slice a, 2026-11-14.** Built as the ticket says, plus these decisions it did not settle:
- Every rule that covers a gate or cap carries a `key` (`CONSTANT` or `CONSTANT.field`); the sync test checks coverage by key and that `ref()` equals the code's value at that key. A rule with no key shows a derived or incidental figure (a tick interval, a per-run budget).
- The registry also covers `META_WINDOWS` and `MARKET_SOURCE_IDS` (named in the ticket's list of constants, not in its item 3). `LEFT_OUT` lives in the test, each entry with a reason; an entry with no reason, or for an item the code no longer has, is itself a gap.
- Node `worker` may be one pass or a list (Meta runs `metaTick` and `metaSummaryTick`). Edges may carry `gates` (rules) and `dashed` (an Operator decision or a path not wired yet, such as Beta finder to Proposals).
- `pipeline-docs.test.ts` and `pnpm docs:graph` use start and end markers `<!-- generated:pipeline-overview -->` ... `<!-- /generated:pipeline-overview -->` (same for `pipeline-lifecycle`). The regenerated lifecycle diagram labels edges `reason (actor)` straight from `TRANSITIONS`. It shows `launched -> closed` with actor `operator`, as the table says; the prose table below it still said "system (phase 3a)" (fixed in slice b).
- Interval constants went to `packages/core/src/ticks.ts`; `SEED_GATE_MIN_SCORE` is exported from `rubric.ts`.
- The page has no poll yet (slice b adds it). The layout puts the Sources chips in a taller Sources node, so the side row (Study, Meta, Beta finder) sits beneath it; a screen narrower than 1206 px scrolls the graph sideways.
- Not done on purpose: the browser box (cos does the Chrome check at 1240 px and a phone width) and the shared "full `pnpm check` per slice" box (kept open for b and c).

**Slice c, 2026-11-14.** Panel built (`PipelineNodePanel.vue`; page state in `pipeline.vue`). Decisions the ticket did not settle:
- Panel is a fixed card on the right of a wide screen and a bottom sheet (max 78vh) under 640 px; it is not modal and has no backdrop. Clicking another node swaps it. Escape is a window listener on the page; focus moves to Close on open and returns to the node on close.
- Nodes are `role="button"` articles (Enter, Space, click). Paths (ADRs, tickets, code) are plain text, no links.
- Gates live on edges, so the panel lists "Lines in and out" for the node with each edge's gates and 24 h count; the Judge panel shows both gates there (the buildability gate is the stored Rubric's value with its version, from the same `getRubric()` the Rubric page reads).
- "used / cap" is shown only for `*.maxRunsPerDay` rules, from slice b's per-node runs (rolling 24 h, as the caps are). Spend caps show no used figure.
- First slice-c box left open: Escape and focus return are asserted on the source only; cos checks them in the browser. Check passed (130 files, 1972 tests), stamped tree `86f240dd07`.

**Recorded manual bite run (slice a).** Added `"fake:bite": "context"` to `SOURCE_CLASS` in `packages/core/src/sources/source-class.ts` with no graph node, ran `pnpm exec vitest run packages/core/src/pipeline-graph.test.ts`, and the sync test failed with: `Source "fake:bite" (class context) is in the Source class table but on no Sources node chip.` Reverted; the tree was clean again.

**Slice b, 2026-11-14.** `GET /api/pipeline-live` (`pipeline-live.get.ts`) over one read, `Datastore.pipelineLive(now, gateMinScore)`, mapped onto the graph by `resolvePipelineLive` (`packages/core/src/pipeline-live.ts`). The page (`pipeline.vue`) polls it every 10 s, draws a count badge on each edge with a metric and a spend block on each node with a `brainTask`, fades a changed number with `<Transition name="pipe-num">`, and keeps the static graph with "Live numbers unavailable." when the fetch fails. Decisions the ticket did not settle:
- Counts, each a range on one indexed time column (migrate adds the missing indexes `brain_runs_created_at`, `signals_ingested_at`, `narratives_created_at`, `scores_created_at`, `proposals_created_at`, `status_history_at`; `study_tokens_first_seen` existed; a test runs `EXPLAIN QUERY PLAN` on each): `signals_ingested` = signals by `ingested_at`; `creates_seen` = `study_tokens` by `first_seen_at`; `narratives_created` = narratives by `created_at`; `narratives_judged` = DISTINCT `scores.narrative_id` by `created_at`, with `passedGate` = those with a buildability at or above the stored Rubric's gate in a Score of the window; `proposals_created` = Proposals with a Narrative by `created_at` (as `researchProposalsSince`); `shortlisted`, `spec_drafted`, `approved` = DISTINCT Proposals that entered the status, by `status_history.at`; `built` = transitions into `built`, `build_finished` = into `built` or `build-failed` (each is one Build, so a re-queued Proposal counts twice).
- Spend is the cost runs reported (`SUM(total_cost_usd)`), not the budget-charged figure `/api/research` holds the caps to: a run that reported no cost shows $0 here rather than its ceiling. Est. usage is `backend != 'api'`, real dollars `backend = 'api'`, in separate fields and separate lines on the node.
- A brain task no node owns (`study`, anything unknown) is summed under `other`, shown as one line under the graph.
- Review follow-ups from slice a, same slice: the `prepare` script spacing; `docs/architecture.md` now says the Operator closes `launched -> closed` today and the system doing it is planned phase 3a; the Meta summary config and each task's per-run budget and wall clock are keyed rules (`DEFAULT_META_SUMMARY_CONFIG.*`, `DEFAULT_ROUTING.<task>.maxBudgetUsd` / `.timeoutMs`, `DEFAULT_META_INTERVAL_MINUTES`), the rest of the summary config is `LEFT_OUT` with reasons; a rule an `ARGUS_*` variable can override has a `live(env)` function, and `GET /api/pipeline` returns the effective value with the code's default beside it when they differ. The War Room cannot read the worker's own environment (no channel, and none was added), so "effective" is what this process's `ARGUS_*` variables give, the same assumption `/api/research` makes; an invalid variable shows the default with an `envError`. The page draws only gates in slice b, so the effective values reach the screen in slice c's panel (the API has them now).
- Not done on purpose: the browser box (cos) and the shared "full `pnpm check` per slice" box.

Slice a check: `pnpm check` passed on the committed tree (128 files, 1951 tests), stamped tree `eb937331a4`; `verify:boot` answered 2xx on `/pipeline` (own temp DB, port 3162).

**2026-11-15, browser check.** Browser evidence (cos, `pnpm page:check` at 02b936d against live :3100, headless, no user/Argus profile): /pipeline 200 at 1240 and 390 px, 0 console/page errors, 0 failed requests; 390 px overflow warning scrollWidth 501 (documented sideways scroll). Keys at both widths: focus #pipe-node-sources (panel hidden) -> Enter -> focus panel-close (panel visible) -> Escape -> focus #pipe-node-sources (panel hidden). Full check per slice: a stamped eb937331a4 (3040f7a), b stamped f0bbd3f187 (68042b2, merged as fd0f0ab after a docs-only rebase), c stamped 86f240dd07 (302932d). Follow-up seen: header nav pill is clipped at 390 px (all pages; not caused by this ticket). Slice b counts on edges: seen by cos in the page:check 390 px screenshot of live /pipeline (main 3c2fd45, slice b live): 1k Sources->Signals, 293 Signals->Narratives, 3 judged / 0 passed the gate, 690 Sources->Study, spend lines $0.006 est. Judge, $0.014 est. Meta.
