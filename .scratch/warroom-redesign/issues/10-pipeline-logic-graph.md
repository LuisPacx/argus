# 10: War Room: a "How it works" page that draws the pipeline logic as a graph and cannot go stale
**Model:** slice a sonnet / high, slices b and c sonnet / med. Slice a sets the data model, the sync test and the generated docs, and a wrong model there costs every later change; b is SQL counts over tables that already exist, c is a side panel that reads the same graph.

**What to build:** the Operator wants "a graphic way of seeing how the logic works ... so I can see what I can improve, change, remove ... updated anytime the logic changes. High level, not fully detailed." Today the only picture is three hand-drawn mermaid blocks in `docs/architecture.md` (system overview `:13`, Proposal lifecycle `:70`, Build Runner `:135`); the Operator reads the War Room, not that file, and nothing makes them follow the code. This ticket adds a War Room page `/pipeline`, nav label "How it works", that draws the pipeline from ONE typed graph definition in code, shows live last-24 h numbers on it, and opens a panel per node. The same definition generates the `docs/architecture.md` diagrams, and a test fails when the code gains a Source, stage, cap or gate the graph lacks.

**Status:** open

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
- [ ] `PIPELINE` in `packages/core/src/pipeline-graph.ts` has the ten stage nodes and Meta, Beta finder and Study, each with a status; RSS catalog, Google Trends and GitHub trending are `context-only`, Beta finder is `off`.
- [ ] Every number in a rule is a `ref()` over an imported constant or config object; no numeric literal stands for a gate or cap (a test fails on a literal value inside a `rules` entry, or the file has none).
- [ ] The sync test enumerates items 1 to 4 above and passes on the current tree.
- [ ] Stays in sync, proved two ways: `pipelineGaps()` is called in the test with a registry that adds a fake Source id, a fake `...Tick`, a fake brain task and a fake config key, and returns a gap for each; and in Comments, a recorded manual run: add a fake Source to `SOURCE_CLASS` (or a fake `new FooSource(` line in `main.ts`) without a graph node, run the test, see it fail naming the Source, revert.
- [ ] `docs/architecture.md` system overview and lifecycle diagrams are generated between markers; editing the graph (or `TRANSITIONS`) without `pnpm docs:graph` fails `pipeline-docs.test.ts`; the Build Runner diagram is untouched and marked as not generated.
- [ ] The generated overview still shows what the old one showed (Telegram, Launch handoff, the Study and Playbook path), via `onPage: false` nodes.
- [ ] `/pipeline` is in the nav as "How it works", renders from `GET /api/pipeline` with no client import of `@argus/core`, and answers 200 in `verify:boot`.
- [ ] The layout helper has a test (columns, rows, edge paths, no overlap); no `v-html`; no new dependency; no JS timer-driven animation.
- [ ] `INGEST_TICK_MS`, `JUDGE_TICK_MS`, `STUDY_TICK_MS` live in core, and `main.ts` imports them.

Slice b:
- [ ] `GET /api/pipeline-live` returns the per-edge counts and per-node spend above for a rolling 24 h; a test with an in-memory store seeds each table and checks every figure, including a row at 23 h 59 m (counted) and 24 h 01 m (not).
- [ ] Est. usage and real API dollars are separate fields; a `study` or unknown task row never crashes the route and is reported under "other".
- [ ] The page shows the counts on the edges and spend on the nodes, refreshes on the poll, and degrades to the static graph when the route fails (tested at the route; browser-checked on the page).

Slice c:
- [ ] A node opens a panel with `what`, status, rules with the real values, ADRs, tickets, files and spend; closing returns focus; Escape works; the panel text is escaped.
- [ ] The buildability gate in the panel is the stored Rubric's value with its version, and equals the number on the Rubric page.

All slices:
- [ ] Full `pnpm check` passes once on the committed clean tree, per slice.
- [ ] Browser check by cos at 1240 px and a phone width: the graph reads left to right, nothing overlaps, `off` and `context-only` are told apart, the live numbers match `/activity` and `/api/research` for the same minute, the panel opens and closes by mouse and keyboard.

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
