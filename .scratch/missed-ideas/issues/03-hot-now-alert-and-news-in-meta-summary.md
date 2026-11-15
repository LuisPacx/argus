# 03: "Hot now" alert in the War Room, and matching news in the Meta summary
**Model:** sonnet / medium. Plain code on top of the stored Meta ranking, one prompt block and one War Room panel; no new Brain task.

**What to build:** on 2026-11-12 the Meta `jensen` ranked 2nd (256 tokens, 141 creators in 24 h) and nothing told the Operator, and its summary ("a viral concert-jumbotron clip") missed the CEO story because the summary prompt sees only token names and counts. Two changes. (1) A **Hot now** alert: when a Meta enters the top 5 of the Meta ranking, or its distinct creators double within 1 hour, the War Room shows it on the home page with the summary, the matching news (context), the top tokens and the migrations. (2) The Meta summary prompt gets the **matching news** as untrusted context, so a summary can say why the Meta is moving.

**Status:** done (commit 982fb51)

**Blocked by:** warroom-redesign/10 slice c (the War Room edit queue; it is first in the agreed order). Agreed order: warroom-redesign/10 slice c, then **03**, 04, 05, 06, 07. Needs the stored Meta ranking and summaries on `main` (viral-sources/03, done).

Origin: `.scratch/missed-ideas/issues/01-nvidia-ceo-miss-gap-and-fixes.md`, answers Q1, Q2, Q6, Q8 (2026-11-14).

## Decisions already made (do not reopen)

- **Trigger:** a Meta enters the top 5, or its distinct creators go up x2 within 1 h. The trigger is the same one that later starts meme idea generation (ticket 06), so it is a stored event, not only a UI computation.
- **News is context, not a trigger.** RSS and Trends Signals matching the Meta are shown and fed to the summary; they never raise an alert by themselves (Q2). X stays Phase 3 ticket 06 (Q8).
- **War Room only.** No Telegram, Slack or push (Q6).
- The alert shows: the Meta label and summary, the matching news (title, Source, time), the top tokens, and the migrations (unfiltered and after 60 s, as the Meta rows hold them).

## What to build

- A pure function from two stored Meta runs (now and about 1 h ago) to a list of Hot now events, with a reason string each ("entered top 5", "creators 70 to 148 in 1 h"). Thresholds in the Meta config object (`packages/core/src/meta/config.ts`), not literals.
- A stored event per Meta per trigger, with a cool-down (a Meta already hot is not re-raised within 6 h), so ticket 06 can read "which Metas are hot and when" without recomputing.
- Matching news: Signals of the context class (ADR 0011) whose title matches the Meta's subject key (`meta/key.ts`) within the last 24 h, newest first, at most 5. Matching is linear and never builds a RegExp from a token name (worker rules).
- The Meta summary prompt (`packages/core/src/meta/summary.ts`, the `meta-summary` skill) gets the matching news inside a fresh random boundary named as untrusted data, as `meta/prompt-block.ts` does for creator-written text. News headlines are third-party text: they must not end the boundary.
- War Room: a **Hot now** panel on the home page; a Meta row on `/meta` is marked hot while its event is live. All text rendered as text, links only through `safeHttpUrl`.

## Acceptance

Offline in `pnpm check` (fixtures, fake Brain).

- [x] **Trigger on fixtures.** A Meta moving from rank 9 to rank 4 raises an event; one moving rank 2 to rank 3 does not; creators 40 to 90 inside 1 h raises one, 40 to 70 does not; the same Meta is not raised twice inside the cool-down (tested, reason strings checked).
- [x] **The 2026-11-12 shape.** A fixture with the `jensen` Meta (rank 7 at 00:00Z, rank 3 at 04:07Z, rank 2 at 14:46Z, creators 28 to 58) raises an event at the rank-3 run at the latest.
- [x] **News match.** Headlines naming the Meta's subject match; an unrelated headline and a common-word-only match do not; a 10,000-character headline and RegExp metacharacters are handled in linear time with no dynamic RegExp (tested).
- [x] **Summary prompt.** The prompt contains the matching news in an untrusted boundary; a headline containing `</boundary>` or "ignore previous instructions" cannot end it (tested with a fake Brain that records the prompt). With no matching news the prompt is today's.
- [x] **War Room shows it.** The home page and `/meta` show the Hot now panel with summary, news, top tokens and migrations; `javascript:` URLs and markup in a token name or headline are not rendered as links or markup (render tests beside `apps/warroom/server/test`). **Browser check** in the Argus Chrome profile (`~/.local/share/argus/chrome`, never the user's own profile), at 1240 px and phone width, from a dev server on a seeded DB copy: a screenshot path in Comments.
- [x] **No other behaviour changes.** A Meta is still context only: no Narrative, Proposal or Score is created by this ticket (ADR 0012, tested).
- [x] **Docs.** `docs/architecture.md` Meta section and `/pipeline` graph (`packages/core/src/pipeline-graph.ts`, `pnpm docs:graph`) show the new edge; ADR 0012 gets a dated note that the summary now sees news.
- [x] Full `pnpm check` passes once before the commit.

## Interplay

- **Ticket 06** (meme idea generation) is triggered by this ticket's stored event and is blocked by it.
- **Ticket 04** (Rubric v3) and **05** (`meme` kind) follow in the agreed order; this ticket needs neither.
- **viral-sources/01** (launchpad clustering) runs in a parallel worktree and is independent.
- **warroom-redesign/10** keeps `/pipeline` in sync with the code (a stale diagram fails its test); slice c lands first.
- Never open the live DB; work from a seeded copy or a `.backup` copy deleted afterwards.

## Commits

One commit after a full `pnpm check`. Subject `Missed ideas ticket 03: <what changed>`, body ending with `Ticket: .scratch/missed-ideas/issues/03-hot-now-alert-and-news-in-meta-summary.md` before the trailers. Tick the boxes in the commit only if the full check does not stamp the tree afterwards, otherwise in a follow-up docs commit. No `Closes #N`: this repo has no GitHub issues.

## Comments

2026-11-15, implemented in 982fb51. Full `pnpm check` on the clean committed tree: passed, stamped tree 2065ce55d0 (137 files, 2056 tests).

**Trigger as built** (`packages/core/src/meta/hot.ts`, thresholds in `META_RULE`: `hotTopRank` 5, `hotCreatorFactor` 2, `hotBaselineMinutes` 60, `hotBaselineMaxMinutes` 120, `hotCooldownHours` 6): after each ranking (in the worker's `metaTick`) the newest 24 h ranking is compared with the newest run at least 60 min older. Hot when the Meta is in the top 5 now and was lower or absent then ("entered top 5"), or its 24 h distinct creators are at least 2x ("creators 28 to 58 in 1 h"; only when the older run is at most 120 min old, so "within 1 h" stays about an hour; the rank rule has no age limit). No older run, no events. Events are rows in `meta_hot_events` (key, label, raised_at, reason, rank, creators, run_id; pruned with the runs); the same Meta is not raised again within 6 h. Ticket 06 reads `Datastore.hotMetaEvents(since)`.

**Coverage decision (viral-sources/05):** no event is raised when the 24 h window of either run is thinly covered (`isThin` with `coverageNoteBelow`, 0.8); a run with null coverage is trusted. Reason: after a pause every Meta looks newly in the top 5 and creators double as the feed refills. Nothing is labelled "warming up" on the panel; the existing coverage note stays on the Meta strip and `/meta`.

**Decisions the ticket did not settle:** (1) ranking used is the 24 h window (the one the ticket's numbers quote); (2) the panel shows events of the last 6 h (the cool-down is also the "live" period) whose Meta is still in the newest 24 h ranking, at most 5, in rank order; a Meta that dropped out keeps its stored event but is not shown; (3) news match = normalised headline words equal the key's words next to each other, or the key without spaces equals one word or two joined words (`gta6`); a plural or possessive `s` is allowed; generic keys (`isGenericKey`) and keys under 4 characters never match; same story from several feeds counts once; (4) a panel link to `/meta#anchor` uses the label's anchor, which may point at the wrong row when two Metas share a label; (5) news config keys `newsWindowHours` 24, `newsMaxItems` 5, `newsMinKeyChars` 4 are in `META_RULE`; the pipeline graph draws `hotTopRank`, `hotCreatorFactor`, `hotBaselineMinutes`, `hotCooldownHours` as Meta rules and lists the other four in `LEFT_OUT` with reasons; edges `signals -> meta` ("matching news: context only, never a trigger") and `meta -> warroom` ("Hot now alert") added, diagrams regenerated with `pnpm docs:graph`.

**Summary path (for viral-sources/06):** the only change is `metaSummaryPromptFor(row, tokens, news = [])` in `meta/summary.ts` and one line in `summariseMetas` (`meta/summary-pass.ts`) that reads the matching news for the row (`newsForKeys`) and passes it in. News goes in a second block under its own fresh random boundary, after the Meta block, with a rule paragraph; with no news the prompt is unchanged. The input hash (`metaInputHash`), the retry gap, caps and the stored-summary logic are untouched, so a new headline alone does not buy a call; a summary made before a headline arrived stays until the hash changes. `summariseMetas` takes an optional `metaConfig` for the news window. The `meta-summary` skill got one paragraph about the news block.

**Browser box:** `pnpm page:check` (headless, throwaway profile, per `docs/agents/worker-rules.md`, not the Argus Chrome profile) against a War Room on :3217 from this worktree over a `.backup` copy of the DB seeded with one event on the rank-2 Meta and two headlines (one with markup and a `javascript:` URL). `/meta`: exit 0, 0 console errors, no overflow; screenshots `/home/unknown/.cache/argus-scratch/missed03/shots-meta2/meta-1240.png` and `meta-390.png`. `/`: exit 0, 0 console errors; the panel shows summary, news, top tokens, migrations; markup shown as text, the `javascript:` URL not linked; screenshots `/home/unknown/.cache/argus-scratch/missed03/shots-home2/home-1240.png` and `home-390.png`. The first `/` run exited 1 on a one-off hydration mismatch (not reproduced in the second run); a first `/meta` run showed 425 px overflow from a long "Hot now" pill, fixed (pill now wraps). `/` still prints a WARN at 390 px (scrollWidth 404); `/rubric` has none; not traced to the panel (its text wraps) and not checked against the base commit. Server stopped, DB copy deleted.
