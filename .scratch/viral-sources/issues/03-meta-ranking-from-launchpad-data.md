# 03: Meta ranking from launchpad data (group tokens into live Metas, rank them, show them to Judge and Propose)
**Model:** sonnet / high — new grouping and ranking logic whose output goes into the judge and propose prompts with creator-written text; the ranking has to be checked against real days, not only fixtures.

**What to build:** Argus does not know what the market's live Metas are. The term exists only in `GLOSSARY.md:48`; there is no Meta code. Add a periodic job that groups launchpad tokens (pump.fun creates and migrations, from `study_tokens` and the stored launchpad Signals) into Metas by shared name, ticker and description, ranks the groups by distinct tokens, distinct creators, migrations and market cap, and makes the ranking available to the judge and propose steps, so a Proposal can ride a Meta that is live now and not only a Google Trends or news item.

**Status:** ready-for-agent

**Blocked by:** nothing in the code. Start after the Phase 3 deploy stack (17, 19, 21, 22) is on `main` and the live DB migrated by it (see Interplay).

**Order (Operator priority, 2026-11-11):** this ticket first, then **04 Beta finder (top priority after tonight's deploy)**, then `warroom-redesign/03` (Current Meta on the home page), then 01, then 02. Because 04 waits on this ticket, deliver it in two parts and commit them separately:
- **Part A, what 04 needs (do first, keep minimal):** slice 1 (token subject key and clone clusters) and slice 3 (ranking and persistence, with 6 h and 24 h windows, per-group migration counts, the run's base migration rate, and DexScreener market cap for the top groups). That gives 04 `latestMetas` with the numbers it ranks "room left" by. Nothing in Part A needs an LLM, an API route or a prompt change.
- **Part B, later (split into a follow-up commit or ticket if Part A is big):** slice 2 (theme Metas: woohao / 咪好 / NIHAO as one), slice 4 (judge and propose prompt block, `GET /api/metas`) and slice 5 (LLM summary). `warroom-redesign/03` needs slices 4 and 5; 04 benefits from slice 2 (ni hao is a theme Meta) but can ship on clone clusters first and say so. Ticket 01 needs only slice 1.

Origin: the Operator's request after the Misu and Meta probes, 2026-11-11 (`.scratch/cos.md`, "USER IDEA", "MISU PROBE", "META PROBE").

## What exists today (checked 2026-11-11, main at 1895ffe, DB copy to 20:00 UTC)

- **No Meta logic.** `clusterNewSignals` (`packages/core/src/narratives.ts:151`) is embedding cosine over Signal titles (`JOIN_THRESHOLD` 0.90, line 114). It has no notion of created, migrated or distinct tokens. A Narrative is argus's own cluster of Signals; a Meta is the market's, and the glossary keeps them apart (GLOSSARY: Meta, `_Avoid_` "Narrative (when meaning a Meta)"). Ticket 01 explains why launchpad Signals do not cluster at all (two Narratives hold 99.4% of them).
- **DexScreener emits one Signal per boosted token** (`sources/dexscreener.ts:135`, about 30 a day), ungrouped. Boosts are paid, so they are biased toward promoted tokens. They did reach GATO and woohao. `DexPair` carries liquidity, volume and 24 h price change but **no market cap or FDV field** today (`dexscreener.ts:25`).
- **The Study stores, it does not group.** `study_tokens` (from 2026-11-09 00:54 UTC) holds mint, name, symbol, creator, `created_at`, `migrated_at`, status; `study_snapshots` holds the description, but only for a minority of tokens (about 8% of migrations before ticket 19's gateway fix).
- **The live Metas of 2026-11-11 (probe, last 24 h):** (1) "ni hao" / the Chinese cat (woohao about $13M, 咪好, NIHAO; about 310 creates and 15 migrations in the DB); (2) GTA VI (GATO about $8.5M, WASTED; about 153 creates, 31 migrations, the most migrations of any); (3) same-name clone clusters: DeepSeek (10 of 11 migrated), IShowSpeed (11), MrBeast. Cat and dog are a carrier, not a Meta; AI names are weak. Proposals 113 to 131 (last 24 h) all rode Google Trends or news (Coachella, NFL, ...); none rode a live Meta.
- **The pump.fun API is Cloudflare-blocked** to us, so market caps cannot come from pump.fun. DexScreener's public API is the source (`search`, `tokenPairs`; about 300 requests a minute on search and token lookups, `dexscreener.ts:5`).
- Two kinds of Meta show up in that list and need different grouping: a **clone cluster** (many creates with the same name or ticker: DeepSeek, IShowSpeed, MrBeast, the Misu copycats of ticket 01) and a **theme Meta** (different names around one idea: woohao, 咪好, NIHAO are three spellings of "ni hao cat"; GATO, WASTED around GTA VI). Exact keys find the first; the second needs shared words or a similarity measure.

## Design

### Slice 1: the token subject key and clone clusters (plain code, no network)

A pure module `packages/core/src/meta/` (name chosen by the implementer):
- `subjectKey(name, symbol)` returns the normalised keys of a token: case-folded, `$`, punctuation, emoji and zero-width characters stripped, whitespace collapsed, CJK kept as is. A token has up to two keys (name, ticker). Linear matchers only: names are creator-written, untrusted, and never built into a RegExp (worker rule).
- `groupTokens(tokens)` merges tokens that share a key into one group (union-find over name keys and ticker keys), so `米苏 ($MISU)` and `Misu ($Misu)` meet through the ticker. A key that is too generic does not merge (a stoplist plus a document-frequency cut: `coin`, `token`, `ai`, `the`, a single character), measured on the DB copy so `$BTC` or `ETH` do not fuse unrelated groups. The group label is its most frequent name.
- Ticket 01 imports `subjectKey` and `groupTokens` for its same-name copycat and cross-source rules, so the two never disagree on what "the same token name" means.

### Slice 2: theme Metas (shared words, then a measured similarity)

Merge clone clusters whose names share a distinctive word, and measure whether a name-only embedding (the production gte-small, titles-only as in ADR 0007) with a high threshold merges woohao, 咪好 and NIHAO without fusing unrelated clusters. Choose the rule by measurement on labelled groups from the DB copy (precision first, as ADR 0007). Description text (`study_snapshots.description`) is secondary evidence only, because few tokens have a Snapshot; use it only to merge, never to split. The Brain is not used for grouping. If slice 2 cannot reach the stated precision, the ticket ships slice 1 and slice 3 and records the result in Comments; an unmeasured theme merge is worse than none.

### Slice 3: ranking and persistence

A recompute job on the worker (every ingest tick or every 15 minutes, config `ARGUS_META_INTERVAL_MINUTES`), for windows of 6 h and 24 h over `created_at`:
- **Per group:** distinct tokens (distinct mints), distinct creators (one creator spamming 50 clones is not 50 tokens' worth of demand), migrations (`migrated_at` set; counted as **unfiltered**: the bot filter, Phase 3 ticket 04, is not built and `migrated_at` is PumpPortal receipt time, so the output labels the figure "migrations (unfiltered)"), the top token by market cap and the group's summed market cap of its top tokens where DexScreener has them.
- **Context for display (ticket warroom-redesign/03 renders these and computes nothing itself):** per group also store `firstSeenAt` (earliest `created_at` of its tokens in the data), per-window counts for both 6 h and 24 h (tokens, creators, migrations) so the page can say whether it is accelerating (6 h share of the 24 h count), up to three top tokens `{mint, name, symbol, marketCapUsd?}`, and a one-sentence plain-language `summary` (**decided by the Operator, 2026-11-11: an LLM summary, generated in this ticket's job; a templated line is too dry**), for example "Chinese-cat 'ni hao' theme around Ansem's pfp; many launches, few migrations". This ticket owns it end to end, in a fifth slice below ("Meta summary task"). A templated numbers line (`312 tokens from 190 creators in 24 h, 15 migrated (unfiltered); top: woohao $13M, NIHAO $2.1M`) is built by plain code too, but only as the fallback shown when no LLM line exists yet, the budget is spent or the call failed; it is stored with `summarySource: "llm" | "template"` so the page can tell them apart.
- **Market cap** comes from DexScreener for at most the top K groups' top three tokens each (K and the call budget configurable, default well under the rate limit), through the existing client (declared host `api.dexscreener.com`, no new host). Add `marketCapUsd` (and `fdvUsd`) to `DexPair`. A lookup that fails or returns nothing leaves the figure absent; the ranking still works without it and says so.
- **Rank** by a documented rule held in one config object (suggested: distinct creators first as the demand measure, then migrations, then market cap, then distinct tokens), with the weights stated and tested. The chosen order is recorded with the reason it beats ranking by raw token count on the 2026-11-11 data (the DeepSeek and IShowSpeed clone clusters have few tokens but 10 and 11 migrations).
- **Base rate and saturation, stored per run for ticket 04:** the run's `baseMigrationRate` (tokens created in the window that migrated, over all tokens created in the window, all groups together) and per group `createsPerMigration` (null when there are none) and `migrationRate`. Migration here is a cohort figure for tokens created inside the window, so a 6 h window under-counts slow migrators; the run says so in a `note` field. Most migrations are fast: of 852 migrated `study_tokens`, the median create-to-migrate is under a minute and the mean 0.3 h (and the 2026-11-08 chain sample found 34% in the same slot, bundled with the create), so the figure is mostly bundled and bot-driven until Phase 3 ticket 04 exists. Store a second count per group, `migrationsAfter60s` (migrated more than 60 s after the create), as the crude organic proxy; show both.
- **Persist** each run additively (new tables, e.g. `meta_runs` and `meta_rows`, idempotent migration, rehearsed on a `.backup` copy) so a day's ranking can be replayed and the Study can later ask "was this Meta live when this token launched". `Datastore.latestMetas(window, limit)` reads the newest run. Rows older than 14 days are pruned.

### Slice 4: availability to Judge and Propose (and a read-only API)

- **Prompts.** The judge prompt (`packages/core/src/judge.ts`) and the propose prompt (`packages/core/src/propose.ts`) get a short block "Live Metas on the market, last 24 h" with the top 5 groups: label, distinct tokens, distinct creators, migrations (unfiltered), market cap when known, and, for the Narrative being judged or proposed, a line saying whether its launchpad Signals or name keys belong to one of them. The block is **untrusted data**: names and tickers are written by token creators, so each field is length-capped, control and invisible characters stripped, whitespace flattened to one line, and the block sits inside a fresh random boundary that the rule text outside it names as data, never instructions (the same shape as ticket 22's migrated-examples block, which this ticket should reuse if it has landed). No Metas (empty Study, failed read): the block and its rule text are omitted and the prompt is exactly today's.
- **No Rubric change.** The Rubric is Operator-owned; the block is context. Whether a Meta match should raise `momentum` is an Operator decision (Open question 2).
- **A Proposal still pairs a Narrative with a Tech** (GLOSSARY). This ticket does not create Narratives or Proposals from a Meta; ticket 01 makes the thematic launchpad Narrative exist, and a match between that Narrative and a live Meta is what the prompt block reports.
- `GET /api/metas?window=24h` in the War Room server, read-only, same shape as the block. No UI page in this ticket (Open question 3).

### Slice 5: Meta summary task (LLM, decided)

A Brain task `meta-summary` following the judge and propose pattern (ADR 0001: `claude -p` with the API fallback; a SKILL.md and a prompt builder beside `judge.ts`; its runs recorded in `brain_runs` so the daily spend and research-quota counters see it).
- **Input:** for one Meta: label, per-window counts, up to 8 tokens (name, ticker, market cap when known, migrated or not, and the Snapshot description when one exists, capped), nothing else. All of it is creator-written and goes inside a fresh random boundary the rule text names as untrusted data (same shape as the slice 4 block). The model is asked for **one line, at most 200 characters, plain language: what the theme is, and one fact about its state (many launches or few, migrating or saturated)**. It may use general knowledge (that is what makes "around Ansem's pfp" possible) but must say nothing it cannot support from the input or well-known public context, and never give advice to buy.
- **Validation:** one line, at most 200 characters, no markup, no URL, no control or invisible characters, not empty; otherwise a repair-free reject, the templated line stands in and the failure is logged (same stance as `parseProposeOutput`).
- **Caching and cost bound.** Only the top 5 Metas of the 24 h ranking are summarised. A summary is reused until the Meta's input hash changes materially (label, the top three tokens, and each count bucketed to powers of two) and it is at least 60 minutes old, so a ranking refresh every 15 minutes makes no call when nothing moved. At most 5 calls per refresh and 40 per day (`ARGUS_META_SUMMARY_MAX_PER_DAY`), a haiku-class route like the judge, counted in the research quota (`usedShareOfQuota`) and under the existing `maxDailyUsd` style cap (`ARGUS_META_SUMMARY_MAX_DAILY_USD`, default 0.25). Budget spent or rate-limited: no call, fallback line, the pass ends (as the judge pass does). Expected cost with these defaults: well under $0.25 a day; the implementer measures and records the real figure in Comments.
- **Storage:** `meta_rows.summary`, `summarySource`, `summaryInputHash`, `summaryAt`; a summary survives to the next run unchanged while its hash holds.

Out of scope: trading, wallets, signing or any chain call (ADR 0002; this reads Signals, Study rows and the DexScreener API it already uses); pump.fun's own API; using DexScreener boosts as a ranking input; changing the Rubric, the Study's capture or `study_tokens`; predicting which Meta will win (the Study's job); the bot filter (Phase 3 ticket 04); a new Source.

## Acceptance

Offline in `pnpm check` (recorded fixtures and fake clients); the DB-copy replay is an opt-in script.

- [x] **Clone clusters (slice 1).** A fixture of tokens with the real 11-11 shapes (11 `DeepSeek` creates of which 10 migrated, 11 `IShowSpeed`, `米苏 ($MISU)` and `Misu ($Misu)` meeting through the ticker, 40 unrelated names) groups into the expected groups, and a generic key (`$BTC`, `coin`, `ai`) does not merge unrelated groups (tested, failing first on `main`).
- [x] **The key is safe.** Names with RegExp metacharacters, zero-width and bidi characters, 10,000-character names and mixed scripts are normalised in linear time without a dynamic RegExp (tested; `pnpm lint` clean).
- [ ] **Theme Metas (slice 2).** On a labelled set built from the DB copy (at least the ni hao and GTA VI groups, each with at least 10 tokens, plus 5 clone clusters that must stay separate), the chosen rule merges woohao, 咪好 and NIHAO into one group and GATO, WASTED and the other GTA names into one, with zero wrong merges among the labelled pairs; the set, the rule and the numbers are in Comments. If that precision is not reached, slice 2 is dropped and the ticket says so (the other boxes still hold).
- [x] **Ranking is expected and distinct-creator aware (slice 3).** A fixture with clone clusters yields the expected order under the documented rule; one creator spamming 50 same-name tokens ranks below 10 creators with 10 same-name tokens each; a group with fewer tokens but more migrations ranks above a larger group with none; a missing market cap neither drops nor invents a figure (tested, including the 6 h and 24 h windows).
- [ ] **Replay on a DB copy surfaces the real Metas.** On a `sqlite3 .data/argus.db ".backup <home-disk path>"` copy (the live file is never opened by argus code; delete the copy afterwards), recompute for 2026-11-11 20:00 UTC with the 24 h window: the ni hao group and the GTA VI group are each in the top 10, and the DeepSeek and IShowSpeed clone clusters are each in the top 10 (market cap absent in the replay unless recorded DexScreener JSON is supplied; say which). The top 20 with their counts go in Comments and are read by hand.
- [x] **Stable and cheap.** A recompute over the 24 h window of a real day (about 12k creates) takes under 5 s of CPU on the DB copy and does not hold a write transaction longer than the insert of its rows; DexScreener calls per run never exceed the configured budget (tested with a counting fake client).
- [x] **Persistence.** The migration is additive and idempotent, a second open changes nothing, a run is stored and `latestMetas` returns the newest, and rows older than 14 days are pruned (tested; rehearsed on a `.backup` copy).
- [ ] **Judge and Propose see it (slice 4).** With Metas present, the judge and propose prompts contain the block inside a random boundary, hostile names (`</boundary>`, "ignore previous instructions", control characters, 10,000 characters) cannot end it or exceed their cap, and a Narrative whose launchpad Signals share a key with the top Meta carries the "matches" line; with none present, both prompts are byte-for-byte today's (tested).
- [ ] **API.** `GET /api/metas` returns the stored latest run for the window, 400 on an unknown window, and escapes nothing a client would render as markup because it returns JSON text only (tested in `apps/warroom/server/test`). Each row carries `label`, `rank`, `firstSeenAt`, the 6 h and 24 h counts, `topTokens` (up to three, `{mint, name, symbol, marketCapUsd?}`), `summary` and the run's `computedAt`; the response also carries the run's `computedAt` and an empty list (not an error) before the first run (tested).
- [ ] **The fallback line.** The templated line is a pure function of the row's numbers, states "(unfiltered)" next to migrations, omits market cap when absent, truncates hostile names to the cap, and contains no markup (tested on the ni hao, GTA VI and DeepSeek fixtures).
- [ ] **Summary task (slice 5).** With a fake Brain: a valid one-line answer is stored with `summarySource: "llm"`; an over-long, multi-line, markup-bearing, URL-bearing, empty or control-character answer is rejected and the fallback line stands; hostile token names (`</boundary>`, "ignore previous instructions") cannot end the boundary and appear only inside it in the prompt (tested).
- [ ] **Caching and cost.** Two recomputes with unchanged input make one Brain call, not two; a changed top-three or a count crossing a power-of-two bucket makes a new call only after 60 minutes; never more than 5 calls in a refresh or the daily cap; budget exhaustion and a rate limit end the pass without error and leave the fallback (tested with a counting fake). The `brain_runs` rows carry task `meta-summary` and the cost lands in the research quota figure (tested).
- [ ] **Docs.** A new ADR (next free number at merge time; 0010 is reserved by hardening ticket 06) records: Metas are grouped and ranked from launchpad data by plain code (the Brain only writes the one-line summary, bounded and cached), are not Narratives and not Proposals, migrations are shown unfiltered until the bot filter exists, and the ranking rule with its reason. GLOSSARY gets one `Meta ranking` entry (or the Meta entry gains one sentence), keeping the existing `_Avoid_`. The ADR notes it contradicts nothing in ADR 0002, 0006, 0007.
- [ ] Full `pnpm check` passes once before each commit.

## Interplay

- **Ticket 01 (launchpad Signals cluster by theme) depends on this ticket's slice 1**, and not the other way round. Why: both need one definition of "the same token name" (same-name copycats, a bond or social Signal naming a token), and the Meta layer is the owner of it because a Meta is defined over tokens, not over Narratives. Ticket 01 should not build a second normaliser. The Meta ranking itself needs nothing from the Narrative clusterer: it reads `study_tokens` and launchpad Signals directly. In the other direction, ticket 01 is what makes the Narrative exist that a Proposal pairs with a Tech; this ticket's slice 4 reports the match between that Narrative and a ranked Meta. Order: Part A (slices 1 and 3), then ticket 04 (Beta finder), then Part B (slices 2, 4, 5) with `warroom-redesign/03`, then ticket 01 (which needs only slice 1) and ticket 02.
- **Ticket 04 (Beta finder)** reads this ticket's stored rows (`latestMetas`, the base rate, saturation and market cap) and is the top priority; keep Part A small so it can start.
- **Rubric v2 and Proposals.** Judge scores stay per Narrative and Rubric version; this ticket adds context to the prompt, not a dimension. Ticket 17's `reason` can cite a matched Meta by label. Ticket 21's panel shows Signals, not Metas; showing the matched Meta there is a follow-up. Ticket 22's migrated-token examples block and this block are both lists of creator-written tokens: share the renderer and the untrusted-boundary code if 22 has merged.
- **Deploy stack.** 17, 19, 21, 22 are on branches (`proposal-tech-value`, `ipfs-gateway`, `why-panel`, `migrated-examples`), not on `main`; the chief-of-staff plan merges them after tonight's live run, migrates the DB on first open and restarts argus. This ticket's migration comes after that and is rehearsed on a `.backup` copy as the 11-11 rehearsal was.
- **Hardening 06 (egress).** No new host: DexScreener is client #2 in that ticket's inventory. If 06 has landed, use the declared client; if not, use `DexScreenerClient` as it is. Nothing here is an open-web fetch.
- **Live run.** A 48 h run uses the main checkout and `.data/argus.db`; develop in a worktree and touch the live DB only through a `.backup` copy.
- **Ticket 02 (TikTok spike)** is independent; a later TikTok Source's Signals could be matched to a Meta by the same `subjectKey`.

## Open questions for the Operator

1. **Rank order.** Suggested: distinct creators, then migrations, then market cap, then token count. Is "demand" (many different creators) the right first key, or do you rank by market cap first, as the market's own Meta lists do?
   **Decided (user, 2026-11-11):** distinct creators, then migrations, then market cap, then token count. "Migrations" in the rank is `migrationsAfter60s` (the organic proxy: more than 60 s after the create); the unfiltered `migrations` count is still stored and shown on every row, and `ARGUS_META_RANK_ORDER` can rank on it instead. The rule lives in `META_RULE.rankOrder` in `packages/core/src/meta/config.ts`. Momentum and a Rubric v3 are not in scope (question 2 stays open).
2. **Should a Meta match feed `momentum`?** This ticket only shows it. Changing how the Rubric uses it is yours (Rubric v3).
3. **A War Room view?** This ticket ships the API and the prompt block; the home-page section "Current Meta (last 24h)" is `.scratch/warroom-redesign/issues/03-current-meta-on-home.md`, blocked by this ticket. A separate Metas page is not planned.
4. **Carrier themes** (cat, dog, AI) are not Metas. The generic-key stoplist handles single words; whether a "cat" group should be shown at all (it is the carrier of the ni hao Meta) is a judgement to review in the replay's top 20.

## Commits

One commit per slice, in order, each after a full `pnpm check`. Subject `Viral sources ticket 03: <slice and what changed>` (for example `Viral sources ticket 03: slice 1, token subject key and clone clusters`), body ending with `Ticket: .scratch/viral-sources/issues/03-meta-ranking-from-launchpad-data.md` before the trailers. Tick a slice's boxes in its commit only if the full check does not stamp the tree afterwards, otherwise in a follow-up docs commit. No `Closes #N`: this repo has no GitHub issues.

## Comments

### Part A done (slices 1 and 3), 2026-11-11

Commit `eed144c` on branch `meta-ranking` (based on `ipfs-gateway` 95d6c79; this ticket file was copied from `main` bfee8bf into the branch to edit it, so expect an add/add on merge: take this version). Full `pnpm check` on the clean committed tree: 100 files, 1643 tests, stamped tree `6d4d5acdb5`. Ticked above: clone clusters, key safe, ranking, stable and cheap, persistence. Left open: theme Metas (slice 2), slices 4 and 5 and their boxes, the Docs/ADR box, the replay box (see below), and the standing `pnpm check` box.

What was built: `packages/core/src/meta/` (`key.ts` subjectKey; `group.ts` groupTokens, stoplist, hub guard; `config.ts` the rule, one place; `compute.ts` recomputeMetas; `store.ts` meta_runs and meta_rows, 14-day prune), `Datastore.latestMetas(window, limit)`, `StudyStore.createdBetween`, `DexPair.marketCapUsd/fdvUsd`, a worker tick every `ARGUS_META_INTERVAL_MINUTES` (default 15, off in `--dry-run` and one-shot), and the opt-in `scripts/meta-replay.mjs`. Env knobs: `ARGUS_META_RANK_ORDER`, `ARGUS_META_DEX_GROUPS` (10), `ARGUS_META_DEX_CALLS` (20 per run). Not in Part A: `summary` and `summarySource` columns (slice 5 adds them additively), prompt block, API.

Choices to know about:
- Rank order is the user's decision above: creators, then `migrationsAfter60s`, then summed market cap (absent sorts after present), then tokens, then the group key. Both migration counts are stored and shown.
- One key space for names and tickers. Whitespace is collapsed to one space (so `Deep Seek` and `DeepSeek` are different keys; a theme rule in slice 2 can join them).
- A group needs at least 2 distinct tokens in the window to be a row; rows are capped at 50 per window per run. Out-of-scope creates (other launchpads) are excluded from the base rate.
- DexScreener: one `tokenPairs` call per group (up to 30 candidate mints, migrated first), top 10 groups per window, hard cap 20 calls a run. The write transaction holds only the inserts (tested with a second connection writing during the lookup).
- Hub guard (`maxPartners` 200): measured max on the DB copy is 72 partner keys (the DacityCoin spam name), so it never fires on this data. The stoplist is `coin, token, ai, the, sol, btc, eth, cat, dog, meme, test, ...` plus any single character.

### Replay on a DB copy (as of 2026-11-11 20:00 UTC, 24 h window, no market cap: no recorded DexScreener JSON was supplied)

Copy made with `sqlite3 .data/argus.db ".backup ~/.cache/argus-scratch/meta-replay.db"` (also the migration rehearsal: `Datastore.open` on the copy migrated it), deleted afterwards. 7,777 pump tokens read, 3,229 groups, 165 ms CPU for the recompute including the insert. Base migration rate 24 h: 3.1% (240/7,777, unfiltered); 6 h: 3.3%.

| rank | tokens | creators | migr (after 60 s) | label |
|---|---|---|---|---|
| 1 | 144 | 82 | 6 (4) | ni hao cat |
| 2 | 62 | 62 | 0 (0) | ELYSION |
| 3 | 78 | 56 | 29 (0) | GTA VI |
| 4 | 54 | 39 | 1 (0) | Bernie |
| 5 | 63 | 37 | 0 (0) | Bugles Cat |
| 6 | 64 | 29 | 1 (1) | BAG |
| 7 | 45 | 29 | 0 (0) | FORK |
| 8 | 51 | 26 | 4 (2) | Justice For Daniela Bittler |
| 9 | 28 | 21 | 4 (1) | fomocat |
| 10 | 20 | 20 | 2 (2) | Greg |
| 11 | 32 | 20 | 1 (0) | Hope |
| 12 | 33 | 19 | 0 (0) | Claudia |
| 13 | 47 | 16 | 6 (5) | TRUPM |
| 14 | 33 | 15 | 0 (0) | GIF |
| 15 | 29 | 15 | 1 (0) | Elon Coin |
| 16 | 22 | 15 | 0 (0) | Qi |
| 17 | 19 | 14 | 1 (1) | Attention Coin |
| 18 | 17 | 13 | 1 (1) | Hold |
| 19 | 17 | 13 | 0 (0) | Māo |
| 20 | 16 | 13 | 1 (0) | boxing cat |

Read by hand: the ni hao group (#1) and the GTA VI group (#3) are in the top 10. The DeepSeek (11 tokens, 11 creators, 10 migrations, all within 60 s of the create) and IShowSpeed (11 tokens, 10 creators, 11 migrations, all within 60 s) clusters are NOT in the top 10: they rank 34 and 40 under the decided order (25 under creators-then-unfiltered-migrations), and the decided order cannot lift them: they have 10 to 11 creators against 13 to 82 for the groups above them, and their migrations are bundled with the create. So the replay box is not ticked: it asks for DeepSeek and IShowSpeed in the top 10, which the decided rule does not give. For comparison, `ARGUS_META_RANK_ORDER=migrations,creators,marketCapUsd,tokens` puts GTA VI #1, IShowSpeed #2, DeepSeek #3, ni hao #4. The ni hao group here is the clone cluster only (the `nihao` ticker links 16 names); woohao and 咪好 need slice 2. Carrier-theme groups (cat names: Bugles Cat, fomocat, boxing cat) do appear; judge in the review whether to hide them (question 4). ELYSION, FORK and Claudia are many creators with no migrations: probably coordinated or bot launches, which the base rate and `createsPerMigration` make visible.
