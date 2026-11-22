# 05: Meta size floor and a "warming up" note (tiny groups never show; say when the window has gaps)
**Model:** sonnet / medium. A config floor in one existing filter, one coverage count added to the run, a note on two components and a test per rule; no new data source and no prompt-format change. Replay on a DB copy is a check, not design work.

**What to build:** (1) A Meta must have at least 3 distinct creators and at least 5 tokens in a window to be ranked, stored or shown anywhere. (2) When the 24 h (or 6 h) window has gaps, the War Room's Current Meta says so ("Only 1 h of data in the last 24 h"), from the real coverage of the window, not from the clock.

Status: done

**Blocked by:** none. The browser box needs `warroom-redesign/11` (headless page check) to exist.

Origin: the Operator's report of 2026-11-14 that the home "Current Meta" looked noisy, and his decisions 2 and 3 the same day. Part of `viral-sources/03` (Meta ranking), ADR 0012.

## What happened (investigated 2026-11-14)

- argus was paused 2026-11-12 17:24Z to 2026-11-14 23:31Z. Right after the restart the 24 h window held about 1 h of launches: run 79 saw 390 tokens in 24 h, against about 3,100 per 6 h on a normal day.
- The rule keeps every group with `minTokens` 2 (`packages/core/src/meta/config.ts:95`, `eligible()` in `packages/core/src/meta/compute.ts:176`) and has no creator floor. So groups of 3 to 6 tokens with no organic migration filled the list: "BEST USDC NARRA 34/28, PENNY 22/21, Life after losing everything 6/6, pop.fun 5/5, skilled chair 6/4, i hope you die 3/3, Black Swan 11/2" (tokens/creators).
- Theme merging was not the cause (clone clusters alone give the same list), so `ARGUS_META_THEMES` is untouched here; turning it off stays a later option.
- On a normal day the 24 h top 10 is far above the floor, so the floor is a no-op there. It only bites when data is thin, which is also when the list is least trustworthy.

## Design (the ticket writer's choice, the Operator can overrule)

### 1. The size floor

- **Defaults:** `minCreators: 3` and `minTokens: 5` (replaces the old `minTokens: 2`), per window, on that window's counts (`counts[w].creators`, `counts[w].tokens`). Both must hold. Add `minCreators` to `MetaConfig` and `META_RULE`.
- **Env:** `ARGUS_META_MIN_TOKENS` (1 to 1000) and `ARGUS_META_MIN_CREATORS` (1 to 1000) in `metaConfigFromEnv`, parsed with the existing `intIn` (junk keeps the default), and added to its doc comment. The existing `minTokens` had no env name; this adds one.
- **Where it applies: inside `eligible()` in `compute.ts`, one place, before the DexScreener budget and before ranking.** Reasons:
  - Everything downstream reads the stored run: `Datastore.latestMetas`, `GET /api/metas`, `MetaStrip.vue`, `MetaList.vue`, the summary task, and the judge/propose block (`meta/prompt-block.ts` reads the same stored rows). Filtering at compute therefore covers all of them with one rule, so the prompt block cannot see a below-floor group and no reader needs its own copy of the number.
  - Below-floor groups also stop costing a DexScreener call (`dexGroups`/`dexMaxCalls` go to real groups) and stop being summarised (`meta_summaries`, top 5 only).
  - The stored `rule` column of `meta_runs` already records the rule used, so a run states which floor made it (check that the new key is in that JSON).
  - A read-side filter would be wrong: the stored rows would keep the noise, a replay would not match the page, and prompt-block would need its own floor.
- Rows already stored by old runs stay in `meta_rows` until the 14-day prune; the next run (15 min) replaces what readers see. The ticket does not rewrite old runs.
- The theme merge (`theme.ts:36`) runs before the floor, so a small cluster that merges into a big Meta still counts toward it; only the final group's size is tested.

### 2. Coverage of the window

- **Measure: hours covered by ingested creates.** For a window of H hours ending at the run time, cut it into H hour buckets (UTC clock hours, the partial current hour counted pro rata is not needed: use H trailing 60-minute buckets ending at `computedAt`, so the buckets are exactly H whole hours). A bucket is **covered** when at least `ARGUS_META_COVERAGE_MIN_CREATES` (default 10) tokens have `created_at` in it. `coverageHours[w]` = covered buckets (0 to H).
- **Why this one:** the thing the ranking counts is creates, so coverage of creates is the honest measure of whether the counts are comparable to a normal window. `meta_runs` alone is a weaker signal: the worker can run every 15 minutes while the PumpPortal feed is down or reconnecting, and a run would then count as coverage over an empty hour. The floor of 10 per bucket (a normal hour holds about 500) keeps one stray create after a restart from counting as an hour. A quiet but healthy hour would still be several hundred, so a genuine lull does not read as a gap. Both numbers are config, and the measure is checked against the 2026-11-12 to 11-14 pause in the replay box.
- **Stored with the run:** two additive columns on `meta_runs`, `coverage_hours_6h` and `coverage_hours_24h` (idempotent migration beside the existing ones in `meta/store.ts`, rehearsed on a `.backup` copy; old runs read as null = unknown, no note). `Datastore.latestMetas`'s result and `metasResponse` carry `coverage: { "6h": {covered, of}, "24h": {covered, of} }`, so `GET /api/metas` and the pages compute nothing.
- **The note:** shown when `covered < of * ARGUS_META_COVERAGE_NOTE_BELOW` (default 0.8; 80% of the window, so 20 of 24 h still reads as a normal list, and 1 h of 24 reads as warming up). Text from a pure function, `coverageNote(coverage, window)` in `packages/core/src/meta/`, so the strings are tested once: `Only 1 h of data in the last 24 h` (singular and plural right; `Only 14 h of data in the last 24 h` for gaps that are not a fresh start). Shown on the home `MetaStrip.vue` (`index.vue:226`) and on `/meta` (`MetaList.vue`), for the window the page is showing. Plain text line above the list, not a modal and not an error colour; the list still shows below it.

### 3. Pipeline graph

`packages/core/src/pipeline-graph.ts` has a sync test (`registry.config` keys must be a rule in the graph or in `LEFT_OUT` with a reason, see the check at `:576`). The new keys (`minCreators`, the coverage minimum creates per hour, the note threshold) are gates or caps and must be covered. Prefer keyed rules for `minCreators` and `minTokens` on the Meta node (they gate what reaches the prompt); the two coverage keys only affect a display note and may go in `LEFT_OUT` with that reason. The `How it works` page and generated diagrams are regenerated if the graph changes (as in `warroom-redesign/10`).

## Open questions (max 3; recommendation first)

1. **Should the judge/propose Meta block carry the same caveat, or be skipped below a coverage threshold?** Recommendation: **skip the block when 24 h coverage is below the note threshold** (the same 80%), and do not add a caveat line. The block's counts (tokens, creators, migrations) are fed to a model that cannot tell 390 tokens from a normal 3,100; a "warming up" line asks a model to discount numbers it will mostly anchor on, and the floor does not fix an all-thin window (it only removes tiny groups). Skipping gives exactly today's prompt, which is the existing no-Metas behaviour (ADR 0012, "with no Metas there is no block and no rule sentence at all"). Cost: for up to a day after a long pause the judge sees no Meta context; that is no worse than before Metas existed. If the Operator prefers, the alternative is one extra line inside the block ("Data covers only N of 24 h"), which is cheap but leaves the thin numbers in. Ask before building the prompt change; the page note and the floor ship regardless, and the default here (skip) is a one-line check in `prompt-block.ts` reading the stored coverage.
2. **Should the 6 h window's note ever show on its own?** After a 3 h outage the 24 h list is 87% covered (no note) while the 6 h list is 50%. Recommendation: yes, each window has its own note by the same rule, shown for the window the page is on; the home strip shows the 24 h window, so it stays quiet in that case.
3. **Are 3 creators and 5 tokens right for a day with normal volume?** Recommendation: ship these starting defaults and read the replay's normal-day output (11-12) before tuning; they are env-overridable and a later change is one number. If a normal-day top 10 loses a real Meta, raise the issue before widening.

## Acceptance criteria

- [x] `MetaConfig` has `minCreators` (default 3) and `minTokens` (default 5), `eligible()` requires both on the window's counts, and `ARGUS_META_MIN_TOKENS` / `ARGUS_META_MIN_CREATORS` override them (1 to 1000, junk keeps the default). The stored run's `rule` shows both.
- [x] Tests with fakes in `compute.test.ts`, at the boundaries: a group of 5 tokens from 3 creators is kept; 4 tokens from 3 creators, 5 tokens from 2 creators, and 34 tokens from 1 creator are dropped; the floor is per window (a group that passes in 24 h but not in 6 h appears in 24 h only); a theme-merged cluster is tested after merging; a dropped group causes no DexScreener call (fake client call count).
- [x] The judge/propose block and `GET /api/metas` never contain a below-floor group (test: build a run with a 4-token group and assert it is absent from `latestMetas`, `metasResponse` and the `metaLines` output).
- [x] Coverage: a pure function over the window's `created_at` values returns covered hours per window; tests with a fake create stream across a pause (24 h of creates, then a 40 h gap, then 1 h of creates: 1 of 24 covered; one stray create in an hour does not count; exactly 10 creates counts; 8 of 24 hours missing in the middle gives 16 of 24), with the covered-hours and window length also checked for 6 h.
- [x] `meta_runs` gains `coverage_hours_6h` and `coverage_hours_24h` by an idempotent additive migration (rehearsed on a `.backup` copy of the live DB), `latestMetas` and `metasResponse` expose `coverage`, and an old run with null columns shows no note.
- [x] `coverageNote` tests: "Only 1 h of data in the last 24 h", plural form, 6 h wording, null for full coverage, null at exactly the threshold, null for unknown (null) coverage.
- [x] `MetaStrip.vue` (home) and `MetaList.vue` (`/meta`) show the note when it is not null, above the list; component or page test for both.
- [x] Open question 1 is answered by the Operator and, if the answer is "skip", `prompt-block.ts` returns no block when 24 h coverage is below the note threshold, with a test; the stored run with no coverage (old run) keeps the block.
- [x] **Replay on a `.backup` copy of the live DB** (never the live file; copy on the home disk, deleted after): recompute with the new rule (a) at run 79's time, where run-79-style rows (BEST USDC NARRA, PENNY, Life after losing everything, pop.fun, skilled chair, i hope you die, Black Swan) no longer appear and the note reads "Only 1 h of data in the last 24 h"; (b) at a time on 2026-11-12 before the pause, where the top 10 24 h Metas are the same set in the same order as the stored run, and no note shows. Record both lists in Comments.
- [x] Pipeline graph: new config keys are keyed rules or in `LEFT_OUT` with a reason, the sync test in `packages/core/src/pipeline-graph.ts` passes, and the `How it works` page and generated diagrams are regenerated if the graph changed.
- [x] Docs: `GLOSSARY.md` "Meta ranking" mentions the floor, ADR 0012 gets a short addendum (floor at compute, coverage measure and why), the `ARGUS_*` names are listed where the other Meta env settings are.
- [x] **Browser check** with `pnpm page:check` (`warroom-redesign/11`, once it exists): `/` and `/meta` at 1240 px and 390 px against a War Room on the `.backup` copy, once with the thin 11-14 data (note visible, no tiny groups) and once with a normal-day run (no note); screenshots read, console clean.
- [x] Type-check and the full test suite pass once before the commit (`pnpm check`: 131 files, 1995 tests, stamped tree a636707372); the live argus and the live DB are not touched.

## Commits

Subject: `Viral sources ticket 05: <what changed>`. The body ends with `Ticket: .scratch/viral-sources/issues/05-meta-size-floor-and-warming-up-note.md` before the trailers. Never `Closes #N`.

## Comments

**2026-11-14, the Operator's answers to the three open questions (all as recommended):**

1. Below 80% 24 h coverage the judge/propose Meta block is **skipped** (not a caveat line). An old run with no stored coverage keeps the block.
2. Each window (6 h, 24 h) gets its own warming-up note, shown for the window the page is on.
3. Ship 3 creators and 5 tokens; confirm with the 11-12 replay that the pre-pause top 10 survives.

**2026-11-14, built (worker):**

- Config in `meta/config.ts`: `minTokens` 5, `minCreators` 3, `coverageMinCreates` 10, `coverageNoteBelow` 0.8; env `ARGUS_META_MIN_TOKENS`, `ARGUS_META_MIN_CREATORS`, `ARGUS_META_COVERAGE_MIN_CREATES`, `ARGUS_META_COVERAGE_NOTE_BELOW` (a decimal share). The floor is in `eligible()` in `compute.ts`.
- `meta/coverage.ts` (new): `coveredHours`, `metaCoverage`, `isThin`, `coverageNote`. Coverage is computed from the 24 h read of creates (all groups), stored in `meta_runs.coverage_hours_6h/24h` (added with `ensureColumn` in `migrate()`, idempotent; the rehearsal ran on the `.backup` copy, see the replay).
- `metasResponse(run, window, noteBelow)` carries `coverage` and `coverageNote`; `metaView` passes `coverageNote` to `MetaStrip.vue` and `MetaList.vue`. `selectMetas` returns no Metas when the stored 24 h coverage is thin.
- Pipeline graph: keyed rules for `META_RULE.minCreators` and `META_RULE.coverageNoteBelow` (and `minTokens` now has its live env value); `META_RULE.coverageMinCreates` is in `LEFT_OUT` with a reason. No diagram rule changed, so no generated diagram or How it works text changed.
- Decisions the ticket did not settle: the threshold env for the note is a decimal share (0 to 1), not a percent; `coverageNoteBelow` is also what the prompt skip reads, so one number governs both; `metasResponse` computes the note on the server so the pages compute nothing; existing tests whose fixtures use 3 to 4 token groups run with the old floor (`minTokens` 2, `minCreators` 1) through a local helper, and `prompt-block.test.ts` fills the 24 h window with filler creates so coverage reads full.

**2026-11-14, replay on a `.backup` copy** (`~/.cache/argus-scratch/viral05-replay.db`, deleted after; no DexScreener client, so market cap, the third rank key, is absent in the recompute):

(a) Run 79 (2026-11-15T00:31Z, stored with the old rule), 24 h top 10 as stored: BEST USDC NARRA STILL NOT BONDED 34/28, PENNY 22/21, Life after losing everything 6/6, pop.fun 5/5, The Black Bear 5/4, WANTED 4/4, the skilled chair 6/4, Catzilla 4/3, i hope you die 3/3, The Black Swan 11/2 (tokens/creators). With the new rule: BEST USDC NARRA 34/28, PENNY 22/21, Life after losing everything 6/6, pop.fun 5/5, the skilled chair 6/4, The Black Bear 5/4. Gone: WANTED, Catzilla, i hope you die, The Black Swan. **Still present: BEST USDC NARRA, PENNY, Life after losing everything, pop.fun, skilled chair**, because they have 5 or more tokens from 3 or more creators (BEST USDC NARRA 28 creators, PENNY 21). The criterion's expectation that all seven run-79-style rows disappear does not hold at 3 creators and 5 tokens: the floor removes the tiny and one-creator groups only. Coverage: 1 of 6 and 1 of 24 covered hours, note "Only 1 h of data in the last 24 h" (6 h: "Only 1 h of data in the last 6 h"). Left for the Operator: if these five should also go, the lever is a higher floor (`ARGUS_META_MIN_CREATORS`) or ranking on coverage-normalised counts, not this ticket's design.

(b) Run 74 (2026-11-12T17:24Z, the last run before the pause), 24 h top 10 as stored and as recomputed, the same set in the same order: 1 Jensen Huang 403/202, 2 ni hao cat 259/176, 3 GTA6 145/97, 4 Saxon James Musk Coin 100/74, 5 Max coin 115/63, 6 Bernie 61/46, 7 AUDACITY TICKER NOT DACITY 210/44, 8 ELON 33/29, 9 Colette Kress 30/21, 10 Rockstar Games 20/20. Coverage 6 of 6 and 24 of 24, no note.

**2026-11-14, replay decision (the user's floor decision):**

Replay (045a156, .backup copy): run 74 (pre-pause) 24 h top 10 unchanged, coverage 24/24, no note. Run 79: coverage 1/24, note 'Only 1 h of data in the last 24 h'; WANTED, Catzilla, 'i hope you die', The Black Swan dropped; BEST USDC NARRA 34/28, PENNY 22/21, Life after losing everything 6/6, pop.fun 5/5, skilled chair 6/4 remain because they meet the floor. The user reviewed this and decided to keep 3 creators / 5 tokens (2026-11-14); the warming-up note labels thin windows. Live after restart 01:22Z 11-15: run 84 coverage 2/2, notes 'Only 2 h of data in the last 6 h' / '... 24 h'.

**2026-11-15, browser check.** Browser evidence (cos, `pnpm page:check` at 02b936d, live :3100): /meta 200 at 1240 and 390 px, 0 errors, no overflow; note 'Only 3 h of data in the last 24 h' shown; all 12 rows meet the floor (smallest 3 creators). Home 200 at both widths, Current Meta shows the same note. Screenshots in the cos session scratchpad (not kept).
