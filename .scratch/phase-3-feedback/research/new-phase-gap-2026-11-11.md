# New phase gap analysis: "study every migrated pump.fun token, find our edge" (2026-11-11, read-only)

The ask: argus studies every day ALL migrated pump.fun tokens, finds new angles / memecoins / meme narratives, understands the memecoin market, raises the % of good tokens, understands which tokens go high or low; later pure-memecoin Proposals (little Tech). Sources: Phase 3 spec + issues 01-16, measurements.md, GLOSSARY.md, ADR 0002/0003/0007, proposal-quality note, and `.data/argus.db` (read-only, snapshot of 2026-11-11 ~14:25Z).

## 0. What the DB holds today (study_tokens / study_snapshots)

Window 2026-11-09 00:54Z to 2026-11-11 14:23Z (about 2.6 days).

Volume (per full day 11-09 / 11-10): creates seen 12.3k / 14.2k (study_tokens rows by first_seen); migrations seen 803 / 736 (migrated_at). About 800 migrations and 13k creates a day.

study_tokens (27,149 rows; columns: mint, status, status_reason, name, symbol, creator, uri, pool, signature, created_at, migrated_at, first_seen_at, metadata_attempts, in_population). Status split:

| status | rows | with migrated_at |
|---|---|---|
| unreadable (metadata HTTP 429) | 11,044 | 402 |
| capped (daily capture run cap) | 5,904 | 150 |
| captured (has Snapshot) | 7,647 | 130 |
| out-of-scope (bonk pool 1,526; no uri 162) | 1,688 | 1 |
| missed (migrate seen, create never seen) | 891 | 891 |
| counted (no website/X link) | 840 | 49 |
| late / pending | 26 | 0 |

Headline: of 1,614 migrations seen, only 130 (8%) have a Snapshot. 891 (55%) are `missed` creates (known PumpPortal gap, measurements.md item 8; by design never backfilled). Of the 723 migrators whose create was seen, 402 died on `metadata: HTTP 429` and 150 on the daily cap. The 429 is the public `ipfs.io` gateway: 9,877 of 13,020 `ipfs.io` uris are unreadable (76%), while `meta.uxento.io`, `metadata.j7tracker`, `pinata` uris are 0% unreadable. Retries also burn the capture cap (42k study_capture_runs rows in 2.6 days for 27k tokens), which causes most of the `capped` rows. So today's "Study" misses 92% of migrators for fixable reasons plus the by-design missed creates. Base rate among creates seen: 732 / 25,624 pump-pool creates migrated = 2.9% (not the 0.6-1.4% of the literature; unfiltered, includes bot bundles; 34% are same-slot).

study_snapshots (7,647 rows, immutable by trigger). Columns: mint, capture_rule_version, captured_at, age_sec, selection_reason, name, symbol, creator, uri, create_event_at, description, image_url, website_url, x_url, telegram_url, site_status, site_detail, site_http_status, site_final_url, site_content_type, site_title, site_text, site_truncated, site_response_ms, site_empty_shell, content_hash. Fill rates:
- description non-empty 58% (4,405), avg 28 chars (tiny: most tokens have no real narrative text)
- image 100%; x_url 96% (7,355); website_url 51% (3,902); telegram <1% (63)
- site fetched ok 40% (3,067); robots-disallowed 440; http-error 321; no website 3,745 (49%); empty-shell flagged on 294 of 3,067 ok (10%); site_title non-empty 2,950; site_text non-empty 2,664, avg 796 chars
- age_sec: 4,506 at 70 s, 2,975 at 60 s, 145 at 80 s (capture timing works)
- `in_population` is 1 for every captured token: 90% of readable tokens have a link (X link alone is 96%), so the "has website or X" population filter does almost nothing; population is effectively "all readable pump creates".
Not stored anywhere today: any outcome beyond PumpPortal's `migrated_at`, any market data (mcap, liquidity, holders, volume), any chain label, any category/tag, X fields, creator history, wallet metrics.

Quick feasibility check of the "dogs/animals work" belief (crude substring match on name+symbol, pump pool only, bot-unfiltered, n tiny): dog/doge/inu/shib/puppy 18 migrated of 1,048 (1.7%); cat/kitty/meow 25 of 1,453 (1.7%); all 732 of 25,624 (2.9%). No dog lift in 2.6 days of data. This is not evidence against the Operator's belief (migration is the wrong target for "works", see 2.2), but it shows the claim must be measured, not assumed.

## 1. What Phase 3 already delivers per part of the ask

| Ask | Phase 3 ticket(s) | Status / blocker |
|---|---|---|
| Study new tokens daily, record how each looked | 01 (done), 02 Snapshot (implemented; one browser check pending; but coverage 8% of migrators, see 0) | running now; needs the IPFS/cap fix |
| Know which migrated, chain-true | 03 chain labeller (24h/7d) | ready; was blocked by `adr-0002.test.ts` banning the Helius host; Operator approved the test change 2026-11-11, queued (s/high) behind the running workers |
| Separate real from bot/wash | 04 bot filter + Organic migration, 11 calibration | blocked by 03; wallet analysis capped by Helius Free credits (measurements item 6: ~65-100k credits/day if all migrators, so population-only + cap) |
| "Understand the market", find angles | 07 Cases/Cohorts + blind `study` task (Narrative, Identity, Tech notes per Snapshot), 08 lesson aggregation + Playbook + weekly review | blocked by 04, 7d wait; first review about 14 days after data is good; only 3 fixed axes of notes |
| Which tokens go high or low | 05 is the X spike (despite its filename `05-outcome.md`); no ticket defines high/low. Outcome = binary Organic migration at 7d (spec s7); crash measure is only for bot-filter calibration (ticket 11, DexScreener `priceChange`) | partially: migrated vs not only |
| Raise our success % | 09 Playbook into judge/propose prompts; 14 backtest + Q20 gate (top decile >= 3x base rate, two consecutive cohorts) | blocked by 07/08; 3b not started |
| X / presence | 05 spike (done, headless OK), 06 X capture job | 06 ready; 200/day cap |
| Own launches' result | 10 own-launch tracking | blocked by 03 |
| Tie to Proposals now | none in Phase 3; proposal-quality note proposes A/B/C (user said yes 2026-11-11), C = capped "examples that migrated" block from study_tokens | in progress outside Phase 3 |

Phase 3 non-goals that collide with the ask (spec s2): "Predicting price, trading, or any PnL" and "Feeding the confounder axes (Presence, Launch mechanics, Timing) into the Rubric or the prompts". The ask wants high/low understanding, which is price-adjacent. Phase 3 also learns only from the 7d-final label, from links-bearing tokens at a fixed 60 s age, and from a 100 runs/day cap.

## 2. Gaps (what no ticket covers)

### 2.1 Meme taxonomy / categories
Phase 3 has none. The blind task returns free notes on Narrative / Identity / Tech and aggregation (ticket 08) compares "per-axis notes", but nothing defines a category field (dog, cat, frog, celebrity, politician, AI, food, anime, ...), so animal-type lessons could not be counted.
Options:
- Fixed list: simple, comparable across weeks, but misses new memes and biases toward our own priors.
- Learned clusters: embed name + symbol + description with the existing in-process gte-small embedder (ADR 0007; cost: zero Claude runs), cluster, then have Claude name each cluster once (not per token). Finds new angles, but cluster ids drift week to week.
- Recommended hybrid: a small versioned seed taxonomy (about 25 tags, multi-label, with "other") assigned to every token by a cheap batched tagger (rules + haiku, no outcome shown), plus a weekly embedding-cluster pass over the "other" and low-confidence bucket that proposes new tags for Operator approval. Taxonomy version stored per tag row (like capture rule version) so lessons stay comparable.
Needs a new table (token_tags: mint, taxonomy_version, tag, confidence, source) and a new glossary term (Meme tag / Category).

### 2.2 Outcome definition for "high vs low"
Ticket 04/07 outcome buckets are non-migrated / organic / bot-driven / fast. That separates "reached the pool" from not, which is a weak proxy: 2.9% of creates migrate, and a migrated token can die in minutes. "Goes high or low" needs a post-migration ladder, none exists:
- Metric: peak and current market cap (USD), liquidity, 24h volume, holder count from DexScreener/GeckoTerminal at fixed ages after migration (migration + 1h, 24h, 7d), plus ratios (mcap at +24h / mcap at migration; peak multiple; alive = liquidity above a floor and volume above a floor at +7d).
- Horizon: relative to migration time (not creation) so tokens are comparable; 1h / 24h / 7d, same as ticket 10's own-launch ages (reuse that DexScreener reader).
- Thresholds (suggested start, to be re-fit on data): tiers High = still above 2x migration mcap at +24h or top decile of the cohort by +24h mcap; Mid; Low = below 0.5x or liquidity gone. Prefer rank/decile within the weekly Cohort over absolute thresholds, because the market regime moves.
- Is it covered? Not by 04/05/07. The nearest: ticket 11 (crash within 20 min, DexScreener priceChange, calibration only) and ticket 10 (1h/24h/7d market data, own launches only). A new ticket must extend those readers to all migrated tokens and store a separate label table.
- Caveat: organic filter (04) then tier is a two-stage label; tier among bot-driven migrators measures the bot's exit, not demand.

### 2.3 Daily volume and cost of "study ALL migrated tokens"
Volume: about 800 migrations/day; a comparable control draw adds up to 800; creates 13k/day.
- Capture: cheap code (no Claude). Today it fails on 429 and the cap (section 0). Fix: gateway fallback list (uxento, pinata, cloudflare-ipfs-style gateways) with backoff, and do not count failed metadata attempts against the 20k cap. Without this, "all migrated tokens" is 8% coverage.
- Missed creates: 55% of migrators have no create row, so no fixed-age Snapshot ever (spec s5, deliberate). For "study all migrated" a second mode is needed: migration-driven capture for every migrate event (fetch uri metadata, which is immutable, plus current website, DexScreener/pump.fun stats), stored with `capture_mode = post-hoc` and age, never pooled blindly with fixed-age Snapshots. This is non-blind for outcome (the token migrated) so it is for descriptive market study, not for predictive training. Metadata uri is available from pump.fun frontend API or chain `CreateEvent` (10 Helius credits) when PumpPortal missed the create.
- Chain: labelling 800/day is trivial (0.01 credit each). Wallet analysis for all migrators: 65-100k credits/day by measurement (over 1M/month Free); needs a per-day cap or the $49 plan (Operator decision, spec Q24).
- LLM: ticket 07 caps Study at about 100 runs/day, one run per Case: that covers about 50 migrators + 50 controls, i.e. 6% of "all migrators". For descriptive tagging of everything: batch 20-25 tokens per haiku run (desc avg 28 chars, site text avg 800 chars, truncate to about 1.5k chars each) = about 65 runs/day for 1,600 tokens, inside the 100 cap or its own share; or tag by rules + embeddings first and send only the residue. Deep per-Case analysis (ticket 07) stays at 100/day. Research quota today: ARGUS_DAILY_QUOTA_USD $20 x research share 30% = about $6/day shared by judge and propose; Study has its own cap inside the $100/mo and never borrows (spec s9). Daily trends/summary run: 1 sonnet run/day over aggregate tables.
- DexScreener: tokens endpoint takes several addresses per call, 3 reads per token (1h/24h/7d) x 800 = 2,400 reads/day; fine at free limits (60-300/min), but terms unconfirmed (data-sources.md).

### 2.4 Predictive model or descriptive lessons
Phase 3: descriptive lessons from code-aggregated counts (lift >= 1.5x, 20 organic migrators, cohort-validated), human-approved into prompts; 3b "cheap brain score" = rules from approved lessons, backtested (gate Q20). No model is planned, and the literature in the spec (AUROC 0.86 -> 0.46 across cohorts) argues for caution.
Recommendation: stay descriptive first (a daily/weekly market report: tag frequency vs migration rate vs tier, by Cohort, with confidence intervals), then a simple, interpretable scorer (logistic regression or decision rules over tags + launch mechanics + timing) evaluated only on later Cohorts. Predicting "high vs low" needs more labelled tokens than Phase 3's floor of 50 Cases; at about 350 migrators/day with Snapshots (after the 429 fix) that is reachable in about 2 weeks, so a model is feasible after the tier label exists. Confounders (Presence, Launch mechanics, Timing) must be included as controls in any model, which contradicts Phase 3's "never into prompts" (fine for analysis, still not for prompts).

### 2.5 Pure memecoin Proposals (little Tech)
Today: Proposal = Narrative + Tech + token angle; Tech is the product that rides the Narrative (GLOSSARY lines 19-20, 27); Build is a Workers web app (ADR 0003); Rubric buildability is a hard gate; propose skill requires a buildable Tech. Pure memecoin Proposals are Proposals without a real Tech.
Options: (a) make Tech optional (null) on the existing Proposal; (b) add a Proposal kind (`tech` | `meme`), where a meme Proposal carries a Concept (name, ticker, mascot description, image prompt, meme tag, "why it should work" from the Playbook) and its Build is at most a landing page from the existing template (still ADR 0003's archetype: a minimal page), or no Build (status goes shortlisted -> approved -> launched).
Recommendation: (b), because (a) breaks the buildability gate, the Spec stage and Proposal status transitions (spec-drafted, building, built) in ways the glossary defines; a kind field keeps those paths untouched. Implied changes: GLOSSARY (Proposal gains kind; Tech "optional for meme kind"; new terms Meme tag, Outcome tier, Meme Proposal/Concept), a new ADR ("Meme Proposals skip the Build path" or "Tech is optional"), Rubric needs its own dimension set (buildability not a gate for meme kind; add "meme fit vs Playbook"), judge/propose skills need a meme branch, War Room list/detail pages need kind-aware views. Identity (name, ticker, image) matters more than Tech here, which is exactly what the Study's Identity axis and the tag/tier data would feed. ADR 0002 still holds: argus does not launch.

### 2.6 Data limits (bots, wash trading, survivorship, selection)
- Bots / wash: 34% of migrators are same-slot bundles (measurements); creator and bot behaviour contaminates any "this meme works" claim. Ticket 04 raw metrics are the fix, but they are not validated (spec s13) and cost credits; until then every number in this note is unfiltered.
- Survivorship / control group: studying only migrated tokens finds traits that merely exist in winners. Every tag statistic needs a base rate from non-migrated tokens of the same Cohort (tag frequency among all creates vs among migrators), which Phase 3 already does with controls (1:1 sample plus weights). With the corrected capture, controls are free (all 13k creates/day have name, symbol, description). The tagger should therefore run on all readable creates, not only a sample, so tag base rates are exact.
- Time: one regime per week; only 2.6 days of data now; tag lift needs Cohort replication (weekly). Memes are seasonal; a lesson from last month may fail.
- Selection bias from missed creates (55% of migrators), 429-dropped metadata (unreadable tokens are not random: they depend on the uri host), and the capture cap.
- Same-name copies and re-launches of one meme: dedupe by normalised name/embedding, otherwise one viral meme counts as 50 observations.
- pump.fun-only: bonk pool excluded (1,526 rows, about 6%).
- X data thin (200/day cap, 6% of creates would be covered); Presence is a confounder anyway.
- Hindsight: any current-state API called after the outcome leaks; the descriptive "all migrated" mode must be labelled non-blind.

## 3. Proposed shape

Recommendation: a new Phase 4 ("Market Study": tags, outcome tiers, daily report, meme Proposals) built on Phase 3's data plane, with two small prerequisite fixes made now inside Phase 3 (capture coverage and the ADR 0002 test change). Do not re-scope Phase 3: its spec is pre-registered (binary label, 3b gate, non-goals), and widening it would delay the 3a acceptance run and muddy the Q20 gate. Pure meme Proposals are a later Phase 5 (or Phase 4 last slice) behind an ADR.

Rough tickets (model/effort; "now" = can start without Phase 3 tickets):

| # | Ticket | Tags | Starts |
|---|---|---|---|
| P3-fix | Study capture coverage: gateway fallback + backoff for ipfs.io 429, failed metadata fetches do not consume the daily cap, report the unreadable/capped rate on the Study page | sonnet / high (touches live worker; merge after the current run's End) | now (design), deploy between runs |
| P3-adr | ADR 0002 test change for read-only RPC (approved) | sonnet / high | queued |
| 4-01 | Meme tag taxonomy v1: seed list, token_tags table, rules + embedding pre-tagger over all readable creates (no Claude), glossary terms | sonnet / high | now (needs only study_snapshots; works on 7.6k rows) |
| 4-02 | Batched haiku tagger for the residue (20-25 tokens per run, no outcome shown, own cap), validator, `--dry-run` | sonnet / medium | after 4-01 |
| 4-03 | Migration-driven capture for ALL migrated tokens (post-hoc mode, uri from pump.fun API or chain, DexScreener stats), capture_mode flag, never pooled with fixed-age Snapshots | sonnet / high | needs 03 for chain fallback; the API-only path can start now |
| 4-04 | Outcome tier labels: DexScreener readers at migration +1h/+24h/+7d for all migrators, tier definition (decile within Cohort + absolute floors), separate table, extends tickets 10/11 readers | sonnet / high | after 03 (reuse reader) |
| 4-05 | Daily market report job (code aggregation: tag counts, migration rate by tag, tier by tag, weighted vs controls, Cohort replication) + War Room page; one sonnet run/day writes narrative text from the aggregates only | sonnet / high | after 4-01, 4-04 (descriptive part with migrated_at can start earlier, flagged unfiltered) |
| 4-06 | Feed tags and approved findings to Playbook: tag lessons go through ticket 08/09 review (no new approval path) | sonnet / medium | after 08, 09 |
| 4-07 | Interpretable scorer on later Cohorts (logistic/rules over tags + mechanics + timing), evaluated on held-out Cohorts; feeds ticket 14's "brain score" | sonnet / high | after 4-04, 04, enough data (about 2 weeks of corrected capture) |
| 4-08 | Dupe/re-launch grouping (same meme many tokens) | sonnet / medium | with 4-01 |
| 5-01 | ADR + glossary: Proposal kind `meme`, optional Tech, Concept fields, buildability not a gate for meme kind | opus / high (design decision) | after Operator answers Q2/Q3 below |
| 5-02 | Judge/propose meme branch, Rubric set for meme kind, War Room kind-aware views, landing-page-only Spec/Build path | sonnet / high each | after 5-01, 4-05/4-06 evidence |

What can start now: P3-fix, 4-01, 4-08 and the descriptive part of 4-03/4-05 (all use data already in the DB, no Helius). After tickets 03/04: 4-04 chain-verified tiers, bot-filtered stats, 4-07. After 08/09: 4-06. After 14 (gate): nothing in this note changes the 3b auto-ladder.

Interaction with the Proposal-quality tickets A/B/C: ticket C (examples block from study_tokens) should use tags once 4-01 exists (e.g. "migrated tokens by tag"), and its renderer is the vehicle for 4-06.

## 4. Open questions for the Operator (ranked, with recommended default)

1. What does "good token" / "high" mean? Reaching migration, or surviving and holding market cap after it (and for how long)? Default: tier by market cap at migration +24h and +7d relative to migration, decile within the weekly Cohort, plus alive/dead floor; organic migration stays the gate.
2. Is Phase 3 left as is (finish 3a, keep its non-goals) and the ask becomes Phase 4? Or should Phase 3 be re-scoped now? Default: Phase 4 after 3a's data plane; only the capture-coverage fix and ADR test change go into Phase 3 now.
3. Meme Proposals: separate Proposal kind (`meme`, Tech optional, at most a landing page, not subject to the buildability gate) or Tech made optional on every Proposal? And when (before or after the Playbook has evidence)? Default: separate kind, built only after 4-05 shows at least one replicated tag lesson.
4. Coverage target: must "ALL migrated tokens" include the 55% whose create the feed never delivered (post-hoc, non-blind, descriptive only), or only those with fixed-age Snapshots? Default: yes for the descriptive daily report (flagged post-hoc), no for predictive training/Playbook lessons.
5. Taxonomy: fixed seed list that you edit, or learned clusters? Default: seed list of about 25 tags you can edit plus a weekly cluster pass proposing new tags for your approval; tell me which tags you already believe in (dogs, cats, frogs, celebrities...) so they are in v1.
6. Spend: raise Helius to the $49 plan if wallet analysis for all migrators is wanted, and set a Claude Study share beyond 100 runs/day for tagging? Default: stay on Helius Free with a daily credit cap (bot metrics for population migrators only), tagging in batches of 20-25 inside the 100/day cap; revisit after one week of measured credits.
7. May the Study's findings include the confounder axes (Presence, Launch mechanics, Timing) in the report and in an analysis-only model, while still never going into prompts? Default: yes for reports and the scorer; no for prompts (keeps spec s2).
8. Should the dogs/animals prior be tested first as an explicit hypothesis (pre-registered) rather than waiting for clusters? Default: yes, make "animal / dog" the first tag family and report lift with confidence intervals after 14 days of corrected capture.
