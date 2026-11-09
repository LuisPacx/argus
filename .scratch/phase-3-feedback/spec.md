# Phase 3: the Study, the Playbook and the auto-ladder

Status: draft for Operator review, before `/to-tickets`. Written 2026-11-07. Decisions are Q1 to Q30 in `.scratch/cos.md` (from "11-07 GOAL (user): Phase 3" and "Phase 3 round 5 DECIDED"); this spec does not reopen them. Where a decision needs a detail it does not give, the detail is either measured by slice 1 or decided in a ticket with a stated default (section 14), not chosen here. Terms follow `GLOSSARY.md` (new: Study, Snapshot, Case, Cohort, Playbook, Organic migration, Fast migration). Research: `research/data-sources.md`, `research/bot-filters.md`. X browser setup: `setup-argus-browser.sh`. Decisions: ADR 0009 (new), ADR 0002 (amended).

## 1. Problem

Argus proposes tokens from news and market Signals, but nothing tells it what makes a pump.fun token succeed. The Rubric (momentum, novelty, buildability, hook, legitimacy) is the Operator's judgement, never checked against outcomes. The old Phase 3 (dismissal reasons, hand-entered outcomes, auto-spec, auto-approve) would automate that judgement without ever testing it.

The Operator wants a learning loop: watch every new pump.fun token that has a website or X link, record what it looked like early, find out later which ones migrated for real, and learn which of the things argus controls (Narrative, Identity, Tech) go with organic migration. The lessons then steer judge and propose, with the Operator approving each one. Only when that brain measurably beats the base rate does the auto-ladder (auto-spec, auto-approve) get switched on.

Facts that shape the design: about 0.6 to 1.4% of tokens migrate (arXiv 2602.14860, 0.63%, Sept 2025); PumpPortal shows about 5% migrating, which is more likely under-captured creates than a different base rate (`cos.md` 11-07 facts); a model that looked good in development fell from AUROC 0.86 to 0.46 on a later cohort (arXiv 2607.02823), so leakage control is part of the design, not a refinement.

## 2. Goals and non-goals

Goals:
- A Study that runs unattended for weeks, capturing Snapshots at a fixed early age with no Claude in the capture path.
- Chain-truth labels (24h provisional, 7d final), with an Organic migration filter that separates bot-driven migrations.
- Blind analysis of Cases by Claude, inside its own run cap and the $100/mo budget.
- A weekly Playbook review in the War Room; approved lessons reach the propose and judge prompts, approved Rubric changes reach the Rubric.
- Automatic read-only tracking of argus's own Launches.
- A pre-registered gate (Q20) for the auto-ladder.

Non-goals:
- Predicting price, trading, or any PnL. The only label is Organic migration (Q1, Q22).
- Auto-launch, a wallet, any transaction (ADR 0002). Argus posts nothing on X and does no promotion (invariant 6).
- Feeding the confounder axes (Presence, Launch mechanics, Timing) into the Rubric or the prompts.
- Backfilling history. The Study records forward from its start; a Snapshot is only valid if it was taken at the fixed age.
- Replacing the Operator's gates. Lessons, Rubric changes and the 3b switches each need an Operator decision.
- Hand-entered outcomes (old scope): superseded by chain tracking (section 11).

## 3. The split

- **3a, Study and Playbook.** Everything up to a reviewed Playbook whose approved lessons are in the prompts, plus own-launch tracking. Nothing in 3a changes which Proposals reach the Operator except through the approved lessons and Rubric edits the Operator makes. Done signal: section 12.
- **3b, the auto-ladder.** Auto-spec for top-scored Proposals and auto-approve above a threshold through the same `approve(store, id, "system", reason)`, each behind an off-by-default config switch with a daily cap in code (architecture invariant 3). Starts only when the Q20 gate passes. 3b also needs the brain's own score (section 12), which exists only after a backtest.

## 4. The six axes (Q4)

Each Case is described on six axes. Only three can become Rubric dimensions or prompt lessons; the other three are recorded so the Study can separate their effect.

| Axis | What it describes | Feeds Rubric/prompts? | Source |
|---|---|---|---|
| Narrative | What story the token rides: topic, hook, timeliness, links to current news | Yes | Metadata description, website text, X posts (Claude reads) |
| Identity | Name, ticker, description, imagery, tone, coherence of the package | Yes | Metadata, website, X profile (Claude reads) |
| Tech | What the site actually does (a working product, a template page, nothing) and how buildable it is | Yes | Website Snapshot (Claude reads) |
| Presence | X account age, followers, posting, early engagement, Telegram link present | No, confounder | X capture, metadata |
| Launch mechanics | Dev buy, creation-slot supply, clustered supply, top-10, creator holding, unique buyers, round-trip volume | No, confounder (and the bot filter inputs) | Chain, section 7 |
| Timing | Hour and weekday, market regime at creation, how many tokens launched in the same hour | No, confounder | Chain, PumpPortal |

Mapping to the Rubric: Narrative maps to momentum, novelty, hook; Tech maps to buildability; Identity has no Rubric dimension today (hook and legitimacy touch it), so a lesson on Identity feeds propose first and may justify a new dimension, which the Operator adds in the existing Rubric editor. The Playbook shows confounder findings to the Operator but they are never approved into a prompt.

## 5. Population and sampling (Q2, Q16)

- **Population:** every pump.fun token created while the Study runs whose metadata names a website or an X link. Tokens with neither are counted (for the base rate) and not studied.
- **Captured broadly, analysed narrowly (Q16).** Capture is cheap code with no Claude: for each token in the population, a Snapshot at the fixed age (section 6). The expensive part, Claude analysis, runs only after the 7d label, on all organic-migration Cases plus an equal number of randomly drawn control Cases from the same Cohort.
- **Control:** a token in the population that had not migrated by 7d. Controls are drawn at random within the Cohort, not matched on outcome or on anything after the fixed age. The Study stores the sampling weight of each Case (population controls per control drawn) so rates can be re-weighted; the 1:1 sample is a deliberate oversample of a base rate below 2%.
- **Strata kept, not dropped:** bot-driven migrators and fast migrators are their own buckets (Q17, Q22). They are stored, counted and also get blind study Cases, so the Study can learn bot signatures (Q22). Those Cases are reported as their own sections (bot-driven, fast) and are never used for Rubric lessons. They count against the same Study run cap (section 9), after organic migrators and controls, which take priority.
- **Missed creates.** A migration whose create the worker never saw (about 59% of migrate rows had no create row on 2026-11-07, partly the lid-suspend outage, partly unknown) has no valid fixed-age Snapshot. It is counted as `missed` and never backfilled at a later age. The missed rate is a Study health number shown in the War Room.
- **Selection under the X cap.** X capture is capped at about 200 per day (section 6), so not every token in the population gets X fields. Which ones do is chosen by a rule that uses only what is known at capture time; the rule and each token's reason are stored, so the bias can be modelled. The rule is decided in its ticket (section 14).

## 6. Snapshot capture (Q3, Q14, Q16)

A Snapshot is a frozen record of one token at a fixed age after creation. It is written once and never edited; analysis reads Snapshots, never the live web.

Fields (field list only):
- Identity: mint, name, symbol, creator, create event time (from chain), metadata URI, capture time, age at capture (capture time minus chain create time, in seconds), capture rule version.
- Metadata: description, image URL, website URL, X URL, Telegram URL (all untrusted; same sanitising as `pumpportal.ts`, `safeUrl`, size caps).
- Website: fetch status, final URL, content type, text content (capped), page title, a content hash, response time; "empty app shell" flag. Fetch is plain HTTP with an SSRF guard (no private addresses), size and time caps, one URL only, robots.txt honoured. 3a uses plain fetch only; a rendered fetch (Cloudflare Browser Run) and Wayback are optional later additions, not part of 3a.
- X: handle, profile fields (display name, bio, created date, followers, following), recent posts (text, time, counts), ticker/name mentions found, capture status (ok, not found, suspended, login wall, challenge), capture time. Optional: the whole feature can be off; Study fields are then null and the loop still works.
- Launch mechanics (raw, section 7) and Timing fields taken from the create event and chain.
- Selection: why this token was captured (population, X priority reason, sampling weight).

**Age (Q3, Q16, Q25).** Fixed ages, set in config and versioned. Decided 2026-11-08 (slice 1, `measurements.md`): metadata and website are captured at age 60 s after create; X at age 5 min (window 5 to 15 min). The research puts median create-to-migrate at 4.4 minutes, so a 1h Snapshot would postdate most migrations and the creator-controlled fields (website, metadata) can change after migration; that is why the ages are early. Slice 1 measured real create-to-migrate times from chain and set the ages and the Fast threshold (60 s, decided 2026-11-08, Q17), recorded in the Snapshot's capture rule version.

**X capture (Q9, Q13, Q14, ADR 0009).** A Playwright script, run by the worker as a plain child process (no Claude in it), opens the dedicated Chrome user-data directory (`ARGUS_CHROME_DIR`, default `~/.local/share/argus/chrome`, created by `setup-argus-browser.sh`) as a persistent context, logged in as the dedicated Argus X account, and saves the profile page, recent posts and a ticker search to the Snapshot as text plus a raw HTML/screenshot artefact. Rules:
- About 200 captures per day (a config cap, counted in code), early-traction candidates first.
- Paced, serial, jittered; one browser process per directory, so a manual check (the "Argus Chrome" launcher) and a capture run cannot overlap (the script takes a lock and refuses if Chrome holds the directory).
- It stops for the day, notifies the Operator, and does not retry on a login wall, a challenge, a lock or suspension signal. It never posts, likes, follows or messages.
- Claude only reads the saved text; the Claude in Chrome extension in the same directory is for manual checks only. Captured X content is untrusted (prompt injection) and goes to Claude as delimited data like Signals.
- The directory holds X cookies: outside git, outside shared backups, mode 700.

## 7. Labels, Organic migration and the Fast bucket (Q10, Q17, Q22, Q23)

**Chain labels.** Each Snapshot'd token is read from chain (Helius RPC, `BondingCurve.complete` via `getMultipleAccounts`, 100 accounts per call) at 24h (provisional) and 7d (final) after creation. Timestamps are chain event times, never PumpPortal receipt times (`published_at` there is when argus received the event, possibly a poll batch time). The Study stores both moments, curve complete and pool created, and the label uses the second ("moved to a swap pool", the glossary sense); which timestamp counts as migrated is measured by slice 1 (section 14). The Study learns only from final (7d) labels (Q10); 24h labels are shown and used for health checks. A token not migrated at 7d is a control, even if it migrates later; late migrators are counted and reported.

**Organic migration (Q22, Q23).** A migration is organic if it passes the five-check bot filter. Raw metrics are stored for every migrator so thresholds can change without recapture:
1. creation-slot supply share (non-creator wallets, create slot plus 2): starting threshold under 10%
2. clustered supply (3 or more wallets with a shared funder, co-purchase transaction or Jito tip pattern, CEX funders excluded) at migration: under 20%
3. top-10 holder share at migration, excluding curve and pool: under 40%
4. creator holding at migration under 5%, and creator has not sold more than 50% of what the creator bought
5. at least 100 unique buyer wallets before migration, and under 30% of volume from wallets whose round-trip ratio is 0.9 to 1.1

The thresholds are hypotheses (`bot-filters.md` section 6), none validated on pump.fun migrators. RugCheck is not used (its terms could not be found; user decision 2026-11-08), so there is no sixth signal; on-chain risk labels come from the chain labeller (ticket 03). The label stays "organic migration"; thresholds are calibrated on post-migration crash (a price drop within the first 20 minutes after migration, MELT-style, plus seller concentration over the Cohort), choosing cut-offs that make the dropped group the one that crashes, then re-checked on a later Cohort. How the crash is measured is decided in the calibration ticket (section 14). Wallet analysis runs only for migrators in the population (Q24).

**Fast migration (Q17).** Migrated within 60 s after creation (chain event times; decided 2026-11-08 from slice 1's measurement, replacing the 30-minute starting value, Q17, Q25). Stored as a flag and a bucket; excluded from Rubric lessons, but fast Cases are studied and reported as their own section (section 5). Fast and bot-driven overlap; the flags are independent and the report shows the cross-tab.

**Outcome buckets per token:** non-migrated (control), organic migrator, bot-driven migrator, plus the fast flag on any migrator.

## 8. Cases, Cohorts and blind analysis (Q16, Q18)

- **Cohort:** the Cases whose tokens were created in the same calendar week of launch (Q30). Cohorts are the unit of time-split validation: a lesson found on Cohort k is tested on k+1, k+2.
- **Case:** a studied token whose label is final (7d), pairing its frozen Snapshot with its outcome bucket. A Case is created only after the 7d label.
- **Blind analysis.** A Study run (`study` Brain task) receives one Snapshot as delimited untrusted data and never sees the label, the bucket, the Cohort's outcomes or the other Cases. It returns structured notes per axis (Narrative, Identity, Tech only; fixed JSON, validated like a Score; anything else refused and not stored). The label is joined afterwards by code, not by the model. Frozen means the run reads only the saved Snapshot: no tools, no web, no `--chrome`.
- **Aggregation is code, not Claude.** Lesson candidates come from comparing per-axis notes across organic migrators and controls (rates, lift, counts, Cohort stability) in plain code; Claude may be asked to propose wording for a candidate, again with the evidence and without labels beyond the aggregate. Each candidate stores its evidence (counts, rates with sampling weights, the Cohorts it holds in).
- **Leakage guards:** fixed age; frozen Snapshots with content hashes; label stored in a separate table and joined after the run; a lesson must hold on a later Cohort than the one it came from before it can be suggested to the Operator; fast and bot-driven Cases excluded from lessons; a lesson candidate is rejected if it is explained by a confounder axis (for example it vanishes after stratifying on Timing or Launch mechanics).

## 9. Study run cap and budget (Q8, Q11, Q24)

- **Run cap:** Study has its own rolling-24h run cap, starting about 100 runs/day (config, lowerable, raising is a reviewed code change like `MAX_NEW_PROPOSALS_PER_DAY`), with a per-run `--max-budget-usd`. It lives inside the $100/mo and never borrows from the judge's or propose's budgets or from Builds. When the subscription window is rate-limited, Study waits; it never falls back to the API (the ApiBrain is judge and propose only).
- **One run per Case.** 100 runs/day covers about 50 migrator Cases plus 50 controls per day, which is more than the 3a gate needs (Q19). Order when the cap binds: organic migrators and controls first, then bot-driven and fast Cases.
- **Dollars (Q26):** the $100/mo counts real cash only (Helius, Cloudflare Browser Rendering and the like). Claude runs are on the subscription and are limited by the Study run cap, not counted in dollars. Fixed line items: Helius Free ($0) first; wallet analysis only for migrators in the population; credits measured in week 1; the Operator is asked before moving to Helius Developer ($49). DexScreener $0; the X capture costs no API dollars (browser). The War Room shows Study spend: runs against cap, Est. usage (informational), Helius credits used, X captures against cap.
- Everything that spends supports `--dry-run` (invariant 2).

## 10. Playbook, weekly review and how it reaches the prompts (Q5, Q12)

**Playbook.** The list of lessons and suggested Rubric changes the Study has produced. A lesson has: statement (one line), axis (Narrative, Identity or Tech), evidence (Cases counted, organic rate against control rate with weights, lift, Cohorts it held in), status (suggested, approved, retired), approval time and the Operator's edit, if any. Retired lessons stay for history.

**Weekly review.** A War Room page lists suggested lessons and Rubric changes with their evidence. The Operator approves, edits, rejects or retires each. The page also has its own section for dismissal reasons (Q27) and one for the Operator's own Launches (Q28). The first review is after about 14 days of data (Q12). A suggested Rubric change is a proposed new Rubric version (reweight, reword, or a new dimension) shown as a diff; approving it applies it through the existing Rubric editor/versioning (ticket 06), so each Score still records the Rubric version it used.

**Into the prompts.** Judge and propose are static skills plus a Rubric that argus writes into each prompt at call time. The Playbook uses the same mechanism: at call time argus renders the approved lessons for that task into a delimited block in the prompt, with the Playbook version.
- Judge gets lessons that help score Narrative and Tech; propose gets lessons on Identity (name, ticker, description tone) and Tech. Each lesson names its tasks.
- The block is capped at 10 active lessons per prompt (Q29), with a character cap set in its ticket, ordered by evidence strength, and stored on each Score and Proposal as a Playbook version, next to the Rubric version, so a change in behaviour can be traced.
- The lessons are Operator-approved text, but derived from untrusted pages; they are re-rendered through the same sanitising (length, one line, no markup) as other prompt data, and the skills say to treat lessons as hints, not instructions that override the output contract.
- A Playbook change never re-judges old Narratives (same rule as a Rubric edit).

**Lesson bar (Q29).** A lesson may be suggested only if at least 20 organic migrators show it and its lift against controls is at least 1.5x (weighted), on top of the Cohort validation in section 8.

**Dismissal reasons (Q27).** The Operator's dismissal reasons (old Phase 3 scope) get their own section in the weekly Playbook review. They are shown beside the lessons, are not Study evidence, and are not approved into prompts by themselves.

## 11. Own-launch tracking (Q6, ADR 0002 amendment)

When the Operator marks a Proposal launched with its mint, argus reads that mint from chain on its own, read-only: whether the curve completed, the migration, and market data (DexScreener) at 1h, 24h and 7d. These outcomes show on the Proposal's details page and in the Study page. No wallet, no keys, no transaction; argus still never launches. Own launches are tracked as outcomes only and kept out of Cohort statistics (they were chosen by the Operator, so they are a biased sample); they get their own section in the weekly review (Q28). At the 7d label argus closes the Proposal itself with the outcome, replacing the manual `launched -> closed` step (Q28). Manual outcome entry is dropped.

## 12. Done signals

**3a done (Q19).** All of:
1. The Study ran 14 days unattended (no operator action beyond known setup).
2. Snapshots were taken daily and chain labels written at 24h and 7d.
3. At least 50 migrator Cases and 50 control Cases exist with final labels, produced within a cap of 100 Study runs per day.
4. The first Playbook review took place in the War Room.
5. At least one approved lesson is present in the live propose or judge prompt (visible as a Playbook version on a stored Score or Proposal).

**3b gate (Q20).** The brain's own score is computed on a later Cohort blind to labels; if the top decile of that Cohort by the brain's score has an organic migration rate at least 3 times the Cohort's base rate (population base rate, not the oversampled 1:1 rate), in two consecutive later Cohorts (consecutive calendar weeks, Q30), 3b may start. How the brain's score is computed cheaply is decided in the first 3b ticket (section 14); the base rate is the population base rate with sampling weights.

## 13. Risks

- **X ToS and account lock.** X's terms forbid access other than through published interfaces; browser automation of x.com is on the wrong side of that. The Operator accepted it for a dedicated account (Q9, Q13, ADR 0009). The exposure is the account (suspension, lock, challenge) and, at worst, the IP; no personal account is involved. Mitigation: dedicated account with 2FA, cap about 200/day, pacing, stop on any challenge, X data optional so the Study degrades to website plus chain. The wizard asks the Operator to create the account, so it is theirs to maintain.
- **Leakage.** Snapshots after the outcome, hindsight APIs (any current-state API called after the outcome), unfrozen pages, or a model that sees labels will all inflate results. Guards in section 8. The 3b gate is the check.
- **PumpPortal timestamps and scope.** `published_at` is receipt time, so timings from the existing Signals are not usable. Migrate scope is unverified (whether it is only pump-to-pumpswap, or other venues); 59% of migrates had no create row. Only one WebSocket connection is allowed, so Study must use the existing Source's connection (extend `PumpPortalSource` to keep `uri` and the raw event fields) and cannot open a second. Gaps (lid suspend) are recorded as gaps. Labels and times come from chain.
- **Chrome headless and unattended runs.** `claude -p --chrome` is not documented and the extension drops its connection on service-worker idle; that is why capture is a Playwright script, not Claude. Remaining risk: X may treat headless Chrome differently; Chrome 136+ ignores remote-debugging switches on the default directory (hence the separate directory); one process per directory; sessions expire; the wizard's extension-permission step is a guess. A spike (slice 6) settles headless against headed (virtual display) before the daily job is trusted.
- **Bot-filter validity.** No published threshold is validated on pump.fun migrators; the five checks may not separate dumpers from survivors. Mitigation: raw metrics stored, calibration on post-migration crash, re-check on a later Cohort.
- **Helius Free budget.** Wallet analysis could exceed 1M credits/month (estimate 0.5M to 6.5M depending on `getTransactionsForAddress` access on Free). Mitigation: migrators only, measure in week 1, ask before $49.
- **Small samples.** Roughly 5 to 30 organic migrators with links per day may be fewer; 50 Cases in 14 days is the floor, not a result. Lessons need evidence thresholds (Q29, section 10).
- **Prompt injection.** Websites and X text are untrusted input to Claude: no tools, delimited, validated output (as judge).
- **Chain format drift.** Pump IDL has `_v2`/`_v3` instructions and `quote_mint`; pin the IDL version and test the labeller against it.
- **Selection bias** from the X cap and from missed creates; recorded, not corrected.
- **Own launches** are excluded from Cohort statistics (Q28), so they never help or distort the lessons.

## 14. Open questions and how they get settled

### Measured by slice 1

Slice 1 (and the X spike, slice 6) produce the numbers; nothing is chosen before then.
- **Snapshot age and Fast threshold.** Decided 2026-11-08 (section 6): metadata and website at age 60 s, X at age 5 min; Fast = migrated within 60 s. Median create-to-migrate is 4.4 min in the literature and the PumpPortal pairs show a median 0.01 min, so the final ages follow the measured distribution.
- **Metadata `uri` source.** Does the PumpPortal create payload carry the metadata URI (`pumpportal.ts` does not keep it)? If not, read `CreateEvent` from chain, which costs Helius credits per create.
- **Which timestamp counts as migrated:** curve `complete` or pool creation (`CompletePumpAmmMigrationEvent`), and the scope of the PumpPortal `migrate` event (pump-to-pumpswap only, or other venues).
- **Helius Free:** whether `getTransactionsForAddress` is allowed on Free, the real limits, and credits per Case.
- **RugCheck:** dropped 2026-11-08 (user decision: terms unavailable); not used, no sixth signal. On-chain risk labels are covered by ticket 03's chain labeller.
- **Headless or headed Playwright** for X, and the lock/challenge detection signals (slice 6 spike).
- Share of website Snapshots flagged "empty app shell" (decides Q31's Browser Rendering fallback).

### Decided in tickets (cos default)

Each is settled in its ticket; the default applies unless the ticket finds a reason to change it.
- **X-capture selection under the 200/day cap:** rank by free signals present in the create payload (initial dev buy, links present), fill the cap in that order, store the reason; trade streams are out (cost, wallet).
- **Crash measure for calibration:** DexScreener `priceChange` windows first (free, crude); pool trades from RPC only if the credits allow.
- **Cheap brain score for 3b:** rules built from approved lessons, applied at capture time with no Claude run; the top decile on a sampled Cohort uses the sampling weights.
- **Bot-driven and Fast overlap:** independent flags, report the cross-tab (section 7).
- **Late migrators and 24h/7d disagreements:** reported only; the 7d label is never adjusted.

### Resolved

- Q25: capture timing (metadata and website at age 60 s, X at age 5 min; decided 2026-11-08 from slice 1). Sections 6, 7.
- Q26: the $100/mo is real cash only; Claude runs are limited by the Study run cap. Section 9.
- Q27: dismissal reasons are their own section in the weekly review. Section 10.
- Q28: argus closes own-launch Proposals at 7d with the outcome; kept out of Cohort statistics. Section 11.
- Q29: lesson bar (at least 20 organic migrators, lift at least 1.5x) and at most 10 active lessons per prompt. Section 10.
- Q30: Cohort is the calendar week of launch; "two in a row" is consecutive weeks. Sections 8, 12.
- Website capture depth (Q31): plain fetch only in 3a, with the "empty app shell" flag (section 6). Slice 1 measures the share of empty shells; if it is large, Cloudflare Browser Rendering is added for flagged sites only, inside the $100/mo, after the Operator approves.

## 15. Suggested slice order

Tickets go under `.scratch/phase-3-feedback/issues/NN-slug.md`. Slices are small and each leaves the system working; 3a first.

1. **Measure create-to-migrate from chain (spike, no feature).** Take a sample of recent migrations from the existing Signals, read the create and migrate events on chain with Helius Free, produce the distribution (create to complete, complete to pool), compare against PumpPortal receipt times, check the migrate scope and the missed-create rate, count Helius credits per call, and test gTFA on Free. Output: a note that fixes the Snapshot age, the Fast threshold, the migrated timestamp and the credit estimate (the "Measured by slice 1" group in section 14).
2. **Study storage and create-event retention.** Tables for tokens seen (chain event time, uri, links, gap markers), Snapshots, labels, Cases, Cohorts; keep `uri` and event fields from the existing PumpPortal connection; no second connection.
3. **Metadata and website Snapshot at the fixed age** (plain fetch, SSRF guard, caps), written once, hashed, with a run cap on the capture job and `--dry-run`. Reports the empty-app-shell share (Q31).
4. **Chain labeller (24h/7d)** and the Study page health numbers (seen, in population, labelled, missed).
5. **Raw bot-filter metrics and the Organic migration label** for migrators, with credit accounting; Fast flag; strata report.
6. **X capture spike.** After the Operator runs `setup-argus-browser.sh` and creates the X account: Playwright on the dedicated directory, headless vs headed, lock/challenge detection, saved fields, the 200/day cap. Results decide whether X stays in 3a.
7. **X capture job** with the selection rule and cap, notification on stop.
8. **Cases, Cohorts and the blind `study` Brain task**, own run cap, per-run budget, output validator, in-flight rows; War Room Study spend panel.
9. **Lesson aggregation and the Playbook** (evidence, Cohort validation, confounder check) and the weekly review page.
10. **Playbook into prompts:** render approved lessons into the judge and propose prompts, store the Playbook version on Scores and Proposals; Rubric change approval through the Rubric versioning.
11. **Own-launch tracking** (independent; can be done any time after slice 1): mint read, outcomes on the Proposal, ADR 0002 amendment in effect.
12. **3a acceptance run** (14 days, Q19), then the first real review.
13. **3b:** backtest harness and the Q20 gate; then auto-spec and auto-approve behind switches (separate tickets, each off by default with a daily cap).

Slices 1 to 5 and 11 need no X and no Claude run. Documentation tickets (architecture, section 16) go after the `arch-doc` branch merges.

## 16. Architecture changes needed (docs/architecture.md, not edited here)

An unmerged branch rewrites that file, so these are listed for a follow-up:
- Header term list: add Study, Snapshot, Case, Cohort, Playbook, Organic migration, Fast migration.
- Section 1: the principle stays; mention `approve()` with actor `system` is 3b only and gated.
- Section 2: add the Study as a second pipeline beside the brain pass (PumpPortal create/migrate, Helius, capture, labeller, Study runs, Playbook, War Room review), and the Playbook arrow into judge/propose.
- Section 3 and glossary: `launched -> closed` and the own-launch outcome fields and the automatic `launched -> closed` at 7d (Q28); the Phase 3 note on dismissal reasons (Q27).
- Section 5: add `study` to `BrainTask` with its route (claude-code, haiku or sonnet to be set), its own caps, and "no API fallback".
- Section 6: the line "No X in v1 ... X returns later through the official API" becomes the dedicated logged-in browser capture (ADR 0009); add Helius as a read-only data sources of the Study (not `Source`s).
- Section 7: the judge/propose prompts carry the approved Playbook block and its version; Scores/Proposals record the Playbook version; Study's caps next to the research share.
- Section 8: War Room Study page and the weekly Playbook review.
- Section 9: Study tables and the capture artefact directory under `.data/`; the Chrome directory outside the repo.
- Section 10: invariant 1 (the Chrome directory holds X cookies; outside git and shared backups); invariant 3 (Study run cap and Helius budget in code); invariant 5 ("no pump.fun calls" becomes: no wallet, no keys, no transactions; read-only chain and public-API reads are allowed); invariant 6 (the Argus X account never posts).
- Section 11: "Not ported: X cookie scraper and burner-account machinery" conflicts with ADR 0009; reword to say argus's capture is a dedicated, read-only, logged-in browser, not the helios cookie scraper.
- Section 12: replace the Phase 3 entry with 3a and 3b and their done signals (section 12 above).
- Section 13: add the open questions that remain after review.
