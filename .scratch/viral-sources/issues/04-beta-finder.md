# 04: Beta finder (propose Betas for the live Metas that still have room)
**Model:** sonnet / high — a new Proposal kind through the store, the state machine, the Brain, the War Room and a backtest; the ranking must be judged on data, and the backtest has to be reported honestly.

**What to build:** argus proposes **Betas** (GLOSSARY: a token whose narrative resembles that of a Meta token already running high, riding the demand of people looking for something similar) for the live top Metas, so the Operator can launch into a Meta that is still carrying tokens to migration. The hard part is not finding the biggest Meta but the one with **room left**: some Metas are saturated (Dacity/Audacity: 1 migration in 228 creates in 24 h), others are still converting (GTA VI: 31 of 153, about 20%). Rank Metas by room left, and for the best few propose a Beta name, ticker and angle that is distinct from every existing clone. Launching stays manual (the Operator, ADR 0002); argus spends no SOL, signs nothing and holds no keys.

**Status:** ready-for-agent

**Blocked by:** 03 Part A (slices 1 and 3 of `.scratch/viral-sources/issues/03-meta-ranking-from-launchpad-data.md`: the token subject key, clone clusters, and the stored 6 h and 24 h Meta ranking with the base migration rate, per-group saturation and market cap). Also start only after the Phase 3 deploy stack (17, 19, 21, 22) is on `main` and the live DB migrated by it.

**Order (Operator priority, 2026-11-11): top priority after tonight's deploy.** Sequence: 03 Part A, then this ticket, then `.scratch/warroom-redesign/issues/03-current-meta-on-home.md`, then 01, then 02.

Origin: the Operator's request after the Meta probe, 2026-11-11 (`.scratch/cos.md`, "META PROBE" and its follow-up). Probe data, 24 h to 2026-11-11 20:00 UTC, migrations unfiltered: GTA VI 31 of 153 (about 20%), "ni hao" cat 15 of 310 (about 5%), DeepSeek 10 of 11, Dacity/Audacity 1 of 228 (a create flood, saturated); base rate about 2.8% of creates (2026-11-09..11). Migration rates per Meta vary by an order of magnitude, which is the whole case for ranking by room left rather than by size.

## Terms and what has to change in the docs

- **Beta** is already in GLOSSARY (line 52); **Meta** (line 48) says a Narrative may match a Meta but they are not the same, and **Proposal** (line 22) is "a Narrative paired with a Tech and a token angle". A Beta Proposal rides a **Meta**, not a Narrative, and its Tech is optional. So the Proposal definition is **contradicted** as written: the ticket amends it ("a Narrative, or for a Beta a Meta, paired with ...") and adds one glossary entry, `Beta Proposal`: a Proposal of kind `beta`; it carries the Meta's numbers at proposal time, has no Spec or Build by default, and is launched by the Operator like any other. Add `Room left` (below) only if the implementer finds the word is used in the UI. Use the glossary words as defined: do not call a Meta a Narrative, a Beta a vamp (Vamping targets one token's flaw; a Beta imitates a narrative).
- **An ADR is needed** (next free number at merge time; 0010 is reserved by hardening ticket 06): "A Proposal has a kind: `narrative` or `beta`". It records the `proposals.kind` column, that a Beta pairs a Meta with a name, ticker and angle, the shortened life and the skipped Spec/Build (Open question 2), that argus still never launches or spends (ADR 0002 stands), and how it relates to the Phase 4 `meme` Proposal kind that the journal (`.scratch/cos.md`, new-phase gap, 2026-11-11) planned for last: this ticket pulls the Beta part forward; the ADR says whether `meme` later subsumes `beta` or sits beside it (Open question 4).

## What exists today (checked, main at 1895ffe)

- A Proposal is `narrative_id`-based: the `proposals` table has `narrative_id` (nullable, unique index `proposals_narrative_id`), `score_id`, `narrative_summary`, `tech_one_liner`, `why_now`, `name`, `ticker`, `description`, `evidence_links`, `collision_checks`, a status machine (new, shortlisted, spec-drafted, approved, building, built, build-failed, needs-human, launched, closed, dismissed) and expiry (48 h in new, 7 days in shortlisted, GLOSSARY: Proposal status). There is no `kind`. The propose step (`packages/core/src/propose.ts`, `parseProposeOutput`) takes a judged Narrative and requires a Tech (ticket 17 adds a Tech-value rule and a required `reason`, on branch `proposal-tech-value`).
- Collision checks (`collision.ts`) already search DexScreener and GitHub for an existing token or repo with a Proposal's name; they run on every Proposal.
- There is no Meta logic at all; 03 adds it.
- The Launch flow (ADR 0002): the Launch button opens the newpairspam token form prefilled from the Proposal (name, ticker, description, logo, preview link); the Operator marks it launched with the mint by hand. A Beta has no preview link and no generated logo; the Operator supplies the image (Open question 5).
- Create-to-migrate is mostly instant in the data: of 852 migrated `study_tokens`, the median is under a minute; the 2026-11-08 chain sample found 34% in the same slot as the create (bundled), so "migrated" without the bot filter (Phase 3 ticket 04, not built) is largely bundle-driven. This ticket must not treat a raw migration rate as demand without saying so.

## Design

### Slice 1: room-left ranking (plain code, offline)

`packages/core/src/meta/room-left.ts` (name by the implementer): a pure function from a stored Meta run (03) to a ranked list of Betas candidates with a score and the reasons. Inputs per group, from 03's rows: distinct creators, distinct tokens, migrations and `migrationsAfter60s` in 6 h and 24 h, `createsPerMigration`, `firstSeenAt`, the lead token's market cap, and the run's `baseMigrationRate`. The rule is one config object with the weights stated and tested; the first version is a gate plus an order, not a magic number:
- **Gates (a Meta that fails any is not offered):** a running lead (the top token's market cap at least a floor, suggested $1M, config), enough evidence (distinct creators at least 5 in 24 h), not saturated (`createsPerMigration` below a ceiling, suggested the inverse of the base rate times 3, config), not fading (the 6 h token count at least a fraction of the 24 h count, suggested one quarter of it, config), and not a Meta whose lead is still being formed (first seen less than 30 minutes ago).
- **Order among the passing Metas:** migration lift = group `migrationRate` over `baseMigrationRate` (using `migrationsAfter60s` when the bundled share is high), then momentum (6 h share of the 24 h count), then lead market cap, with distinct creators as the tie-break. The reason strings say which gate or term decided.
- **Why not size:** record in Comments the 2026-11-11 table showing size order and room-left order on the same data (GTA VI and DeepSeek should rank above "ni hao" and far above Dacity/Audacity, which the gate removes).

### Slice 2: the distinct-name rule (plain code, offline)

A Beta's name and ticker must not be a copy of any token already in the Meta group or the DexScreener search results for the name (03's `subjectKey` is the comparator): rejected when the normalised name equals, or the normalised ticker equals, or the normalised name is within edit distance 1 of, any existing token key in the group; case, punctuation, emoji and `$` do not make a name distinct. A rejected output is not repaired by the model (it goes back once with the offending names listed, then fails closed). Linear matchers only, never a RegExp built from a token name.

### Slice 3: the Beta proposal task (Brain) and the Proposal kind

- **Store:** additive, idempotent migration (rehearsed on a `.backup` copy): `proposals.kind TEXT NOT NULL DEFAULT 'narrative'`, `meta_label TEXT`, `meta_snapshot TEXT` (JSON: the Meta row and the run's base rate as they were, immutable once written), `meta_id` or the run id. A Beta has `narrative_id` NULL. Old Proposals read `narrative`. A unique index keeps one live (new or shortlisted) Beta per Meta group key at a time.
- **Brain task `beta`** (a SKILL.md and prompt builder beside `propose.ts`; ADR 0001; recorded in `brain_runs` and counted in the research quota and daily cap): input is one Meta row, its top 8 tokens (name, ticker, market cap, migrated or not, description when a Snapshot exists), the existing names to avoid, and the rule text. All creator-written text sits inside a fresh random boundary named as untrusted data (as ticket 22's block and 03's slice 4). Output is one JSON object: `name`, `ticker`, `description` (the angle: how it resembles the Meta and how it differs), `reason` (one line, at most 300 characters: which Meta, which numbers, why now), `angle` kind; no Tech needed (an optional one-line `tech` is accepted, never required, and the Tech-value rule of ticket 17 does not apply to a Beta). Validated by `parseBetaOutput` (lengths, ticker 2 to 10 letters or digits, no markup or control characters, the slice 2 rule). It must not copy a real private person's name, a trademark owner's mark, or a token's image; it uses the existing propose safety wording.
- **Cadence and cost bound:** the pass runs after each Meta recompute (03), takes at most the top 3 Metas by room left, at most 1 live Beta per Meta, at most 6 new Betas a day (`ARGUS_BETA_MAX_PER_DAY`), and counts in the research quota and `maxDailyUsd` as the judge does; budget spent or rate-limited ends the pass without error.
- **Life:** a Beta in `new` expires after 6 hours (`ARGUS_BETA_TTL_HOURS`, not the Narrative Proposal's 48 h): a Meta is a matter of hours. Statuses used: new, shortlisted, dismissed, launched, closed. It skips spec-drafted, approved, building, built, build-failed and needs-human (Open question 2); the commands that would enter them are refused for a Beta with a clear message, tested.
- **Switch:** `ARGUS_BETA_PROPOSALS`, default **off** until the Operator has read the backtest (below); a dry run never calls the Brain. Setting it on is the Operator's decision (Open question 1).

### Slice 4: War Room

Beta Proposals appear in the Proposals list and on the Proposal page with a `Beta` pill, the Meta label and its numbers as stored in `meta_snapshot` (tokens, creators, migrations unfiltered, creates per migration, 6 h and 24 h counts, lead token and market cap, the room-left reasons), and the Launch button as for any Proposal. The list can filter by kind. Everything from the Meta and the Brain is untrusted text, rendered as text only and linked only through `safeHttpUrl` (warroom-redesign/02). The Telegram announcement of a new Proposal says "Beta of <Meta>" for a Beta. The Why-this-Proposal panel of ticket 21 shows the Meta numbers for a Beta where it would show Signals.

### Slice 5: backtest (the evidence, run before the switch is turned on)

An opt-in script `scripts/backtest-beta.mjs` (not part of `pnpm check`) on a `.backup` copy of the live DB (never open the live file; delete the copy). History is short: Signals from 2026-11-06 18:28 UTC, `study_tokens` from 2026-11-09 00:54 UTC, so roughly 2.5 days; say so.
- For each hourly time T in the usable range, compute the Meta ranking **using only rows with `created_at` and `migrated_at` at or before T** (a test proves no later row is read), and the room-left ranking from it.
- For the top 3 passing Metas at T, take the tokens created in the same Meta group in (T, T+6 h] and (T, T+24 h] by creators not seen in that group before T (the closest stand-in for "a new Beta launched at T"), and measure whether they migrated within the same horizon, unfiltered and after-60-s, against (a) the base rate of all creates in the same window, (b) the same measure for the top 3 Metas by size, and (c) for Metas the gates rejected.
- Report in Comments, honestly: the counts, the rates with Wilson 95% intervals, the lift over base and over size-ranking, the number of independent Meta-hours (hourly snapshots overlap and the windows are autocorrelated), the share of Beta names that slice 2 would have rejected, and the caveats (about 2.5 days, selection bias because tokens that joined a Meta were already riding it, migration is not profit, bundled migrations). **If there is no lift, or the interval includes zero, say so plainly; the ticket is still done and the switch stays off.** The result also goes into the ADR.

Out of scope: launching, trading, signing, holding keys or spending SOL (ADR 0002); generating a logo or image; scoring a Beta with the Rubric (the Rubric scores Narratives: Open question 3); the bot filter (Phase 3 ticket 04); predicting profit; a Spec or Build for a Beta; Telegram or Slack beyond the one label; the Phase 4 `meme` kind beyond the ADR note.

## Acceptance

Offline in `pnpm check` (fixtures, fake Brain, fake DexScreener); the backtest is opt-in.

- [ ] **Room-left ranking on a fixture (slice 1).** A fixture of Meta rows with the 2026-11-11 shapes (GTA VI 153 creates and 31 migrations, ni hao 310 and 15, DeepSeek 11 and 10, Dacity 228 and 1, a Meta with a $50k lead, a Meta first seen 10 minutes ago, a Meta whose 6 h count is a tenth of its 24 h count) yields the expected order and the expected gate rejections with the reason strings; a larger Meta does not outrank a smaller one with more room left; the same input twice gives the same output (tested, failing first).
- [ ] **Look-ahead guard.** The ranking and the backtest read only rows at or before T; a fixture with a row after T that would flip the order does not change it (tested).
- [ ] **Distinct names (slice 2).** Exact name, exact ticker, a name differing only by case, `$`, punctuation, emoji or zero-width characters, and a name one edit away from an existing token are rejected; a name sharing only a word is accepted; 10,000-character names and RegExp metacharacters are handled in linear time with no dynamic RegExp; the retry-once then fail-closed path works with a fake Brain (tested).
- [ ] **Output validation (slice 3).** `parseBetaOutput` accepts a valid object with no Tech, refuses a missing or over-long `reason`, a bad ticker, markup, control characters and a copy of an existing name; hostile token names in the prompt (`</boundary>`, "ignore previous instructions") cannot end the boundary (tested).
- [ ] **Kind, migration and lifecycle.** The migration is additive and idempotent and old Proposals read `narrative` (tested, and rehearsed on a `.backup` copy); a second live Beta for the same Meta is refused; a Beta in `new` expires after the configured TTL while a Narrative Proposal keeps 48 h; the spec, approve and build commands are refused for a Beta and a Launch/mark-launched works (tested through the real command path).
- [ ] **Caps and switch.** With the switch off nothing is called; on, at most 3 Metas per pass, 1 live Beta per Meta and 6 a day, and budget exhaustion or a rate limit ends the pass cleanly (tested with a counting fake).
- [ ] **War Room shows it.** The Proposals list and the Proposal page show a Beta with its Meta and numbers from `meta_snapshot`; the kind filter works; an `javascript:` URL and markup in a token name are not rendered as a link or markup (render tests beside `apps/warroom/server/test`). **Browser check:** with the dev server started from the worktree and a seeded DB copy that contains at least two Beta Proposals, a screenshot of the Proposals list and of one Beta's page (taken with the Chrome tooling, saved under `.scratch/viral-sources/` and cited in Comments) shows the pill, the Meta label and the numbers legibly at desktop and phone width; the server is stopped by PID afterwards.
- [ ] **Backtest reported (slice 5).** The script runs on a DB copy and the Comments hold the table, the intervals, the lift or its absence and the caveats above; the default of the switch is set from it (off if no lift).
- [ ] **Docs.** The ADR (Proposal kind) is written and states what it contradicts (GLOSSARY Proposal definition) and what it leaves alone (ADR 0002); GLOSSARY gets the `Beta Proposal` entry and the amended Proposal definition; `docs/agents/worker-rules.md` needs no change.
- [ ] Full `pnpm check` passes once before each commit.

## Interplay

- **03 (Meta ranking).** This ticket reads 03's stored rows and uses its subject key; if 03 Part A changes a field name, change it here, not the other way. Metas that are theme Metas (ni hao as three spellings) are only found if 03 slice 2 exists; until then a Beta offered for "ni hao" is offered for whichever clone cluster ranks, and the Comments say so.
- **Rubric v2 and Proposals (17, 21, 22).** A Beta is not scored by the Rubric, so it has no `score_id`; the Proposals list sort "Score" must put Betas in a defined place (suggested: after scored ones, newest first), tested. Ticket 17's required `reason` is mirrored in `parseBetaOutput`; the Tech-value rule does not apply. Ticket 21's `GET /api/proposals/:id` gains the Meta snapshot for a Beta. Ticket 22's migrated-token examples block is a natural extra input for the Beta prompt; reuse its renderer if merged, otherwise leave it out.
- **Ticket 01 (launchpad Narratives).** Independent: a Beta needs no Narrative.
- **Hardening 06 (egress).** No new host: DexScreener, through the declared client.
- **Live run.** A 48 h run uses the main checkout and `.data/argus.db`: develop in a worktree, touch the live DB only through `.backup` copies, and keep the switch off in any run you start.
- **Phase 4.** The Market Study spec plans a `meme` Proposal kind last; see the ADR note above.

## Open questions for the Operator

1. **Switch default.** Off until you have read the backtest (this ticket's default), or on from the first deploy of the code with the backtest read afterwards?
2. **A Beta's lifecycle.** Suggested: no Spec or Build, 6 h life, you launch it from the Proposal page. Do you want a short Build for a Beta that ships a one-page site (Tech optional) or never?
3. **Rubric for a Beta.** Suggested: none, the Meta numbers stand in. Or a separate small rubric (hook, distinctness) later?
4. **`beta` or the Phase 4 `meme` kind?** Suggested: ship `beta` now and let the ADR say `meme` may later subsume it.
5. **The image.** A Beta needs a logo for the newpairspam form. Suggested: the Proposal says "bring your own image"; a generated image is a separate ticket.
6. **Gates.** Lead market cap floor $1M, at least 5 creators, saturation ceiling about three times the base rate's inverse, 30-minute minimum Meta age: are these the right starting numbers? They are config, and the backtest will show how they behave.
**Decided (user, 2026-11-11):** the Beta switch defaults to off until the Operator has read the backtest; a Beta has no Spec, no Build and no Rubric score, and lives 6 h; `beta` is a new `proposals.kind` with its own ADR, and the GLOSSARY Proposal entry is amended (a Beta pairs with a Meta, not a Narrative); the logo is bring-your-own-image.

## Commits

One commit per slice, in order, each after a full `pnpm check`. Subject `Viral sources ticket 04: <slice and what changed>` (for example `Viral sources ticket 04: slice 1, room-left ranking`), body ending with `Ticket: .scratch/viral-sources/issues/04-beta-finder.md` before the trailers. Tick a slice's boxes in its commit only if the full check does not stamp the tree afterwards, otherwise in a follow-up docs commit. No `Closes #N`: this repo has no GitHub issues.

## Comments
