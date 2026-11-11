# 03: War Room home: replace "Latest Signals" with "Current Meta (last 24h)"
**Model:** sonnet / medium — one section replaced, one API consumed; the ranking, grouping and summary text all come from ticket viral-sources/03, so the page computes nothing.

**What to build:** the home page's "Latest Signals" section (a feed of 50 raw Signals) goes, and in its place sits **Current Meta (last 24h)**: the live Metas, ranked, each row giving context and not only a name. The Operator calls this key: the first thing the page should say is what the market is doing now.

**Status:** deployed 2026-11-11 (main 1270357)

**Blocked by:** `.scratch/viral-sources/issues/03-meta-ranking-from-launchpad-data.md`, Part B (slices 4 and 5: `GET /api/metas` and the LLM summary). It renders that ticket's stored ranking and has no ranking logic of its own. Order (Operator priority, 2026-11-11): viral-sources 03 Part A, then viral-sources 04 (Beta finder), then this ticket, then viral-sources 01 and 02. Overlap with `02-safe-links-everywhere.md`: see Interplay.

## What is there today

`apps/warroom/app/pages/index.vue`:
- line 82: `const { data: signals, refresh: refreshSignals } = await useFetch("/api/signals", ...)`; line 86: `refreshSignals()` in the 3-second poll.
- lines 253 to 266: the section. `<div class="surface grid content-start gap-4" :class="{ 'lg:col-span-2': !research }">` (253), `<h3 class="section-title">Latest Signals</h3>` (254), the empty-state note "No Signals yet. The worker polls its Sources (RSS, Google Trends, DexScreener) every 5 minutes." (255), then a list (256 to 265) of `s.sourceLabel` pills, `fmtWhen(s.publishedAt)` times and the title as a raw `:href="s.url"` link at line 262 (the site `02-safe-links-everywhere.md` lists). The section sits in the summary band beside the research panel (`research`, lines about 230 to 250) and closes at line 267 with `</section>`.
- `apps/warroom/server/api/signals.get.ts` (`useStore().latestSignals(50)`) and `apps/warroom/server/test/signals.test.ts` serve only this section. `Datastore.latestSignals` stays (used by `packages/core/src/signals.test.ts` and `apps/worker/src/ingest.test.ts`).
- Signals remain visible where they matter: a Narrative's own Signals on `narratives/[id].vue`, and per-Source health on `/activity`. Nothing else shows the raw feed after this change; that is intended.

## The new section

Heading **Current Meta (last 24h)** (`<h3 class="section-title">`, same surface and grid placement as the old section, keeping the `lg:col-span-2` rule when the research panel is absent). Data from `GET /api/metas?window=24h` (viral-sources/03), fetched and refreshed like the other panels, but on a slower poll (the ranking changes every 15 minutes at most: refresh every 60 s, not 3 s). Show the top 5 groups. Each row (a `<li>` with `data-test="meta-<rank>"`) shows:

1. **Name:** the Meta label (rank number beside it).
2. **Why it counts, in numbers:** distinct tokens launched, distinct creators, migrations labelled "(unfiltered)" until the bot filter exists, and creates per migration (so a flood with few migrations reads as saturated).
3. **Trend:** tokens in the last 6 h against the last 24 h (for example "120 of 312 in the last 6 h") with a plain word for it ("accelerating", "steady", "fading", from the stored 6 h share, thresholds in one constant), and "first seen 14 h ago" from `firstSeenAt`.
4. **Top tokens:** up to three as `name ($TICKER) $mcap`, market cap only when known. A token links to its DexScreener page only when the API supplies a URL, through the safe-link component.
5. **The summary line** (below), in muted text under the name.

The section footer says when the ranking was computed ("ranking from 12 minutes ago", from `computedAt`); empty states: before the first run "No Meta ranking yet. The worker computes it every 15 minutes."; if the stored run is older than 2 hours "The Meta ranking is stale (computed N hours ago)." in the amber note style used elsewhere on the page.

### The summary line (decided by the Operator, 2026-11-11)

The plain-language line, for example "Chinese-cat 'ni hao' theme around Ansem's pfp; many launches, few migrations", is **an LLM summary generated in viral-sources/03's job** (its slice 5: a `meta-summary` Brain task, bounded and cached per ranking refresh, with a templated numbers line as the fallback when none exists yet). This page only displays the `summary` field and its `summarySource`; it never calls a model and never builds the text. When `summarySource` is `template` it shows the line as is (it is still true, only drier). The summary is untrusted model text derived from creator-written names: rendered as text only (`{{ }}`, never `v-html`), single line, clamped.

## Acceptance

- [x] The "Latest Signals" section, its `useFetch("/api/signals")` and `refreshSignals()` are gone from `index.vue`; no heading or test id from the old section remains (grep clean); `/api/signals` (`signals.get.ts`) and its test `signals.test.ts` are deleted because nothing renders them; `Datastore.latestSignals` stays.
- [x] The new section is titled exactly "Current Meta (last 24h)" and takes the old section's place in the layout (same grid cell, same `lg:col-span-2` behaviour when the research panel is absent).
- [x] Each of the top 5 rows shows name, distinct tokens, distinct creators, migrations marked unfiltered, creates per migration, the 6 h versus 24 h trend word with the counts, first seen, up to three top tokens with ticker and market cap when known, and the summary line (render test over a fixture API payload for the ni hao, GTA VI and DeepSeek shapes; fields absent in the payload are omitted, never shown as `undefined` or `NaN`).
- [x] The trend word and the age text come from small pure functions in `apps/warroom/app/utils/` with unit tests at their thresholds (accelerating, steady, fading; 0 tokens; first seen in the future clamps to "just now").
- [x] Hostile payload test: token names, labels and a summary containing markup, `</script>`, a `javascript:` URL and 10,000 characters render as text, clamped, with no `<a>` carrying an unsafe `href` and no raw HTML.
- [x] Every link in the section goes through `safeHttpUrl` / the safe-link component of `02-safe-links-everywhere.md`; the lint rule of that ticket (`argus/no-raw-href`), if merged, passes without a disable.
- [x] Empty (no run yet) and stale (older than 2 hours) states render their messages; the fetch polls every 60 s and not every 3 s (tested at the component level or by asserting the interval constant).
- [x] `verify:boot` still GETs `/` healthily on the real dev server (its page list is generated from `app/pages`, nothing to add).
- [x] **Browser check:** start the dev server from the worktree against a `.backup` copy of the live DB that has a stored Meta run (viral-sources/03 populated on the copy), open `/` in Chrome with the Chrome tooling, and save a screenshot of the section with real data at desktop and at phone width under `.scratch/warroom-redesign/`, cited in the ticket's Comments; confirm by eye that rows are legible, nothing overflows and the summary line is not truncated mid-word. Stop the server by PID and delete the DB copy afterwards.
- [x] Full `pnpm check` passes once before the commit.

## Interplay

- **`02-safe-links-everywhere.md`** touches `index.vue:262`, the very line this ticket deletes along with the old section. Whichever merges second rebases: if 02 lands first, its change to that link disappears with the section and its other sites (`narratives/[id].vue:69`, `UrlLink.vue`) are unaffected; if this lands first, 02's list loses that site, and it should note so in its Comments. The new section's links use the safe-link component from the start.
- **viral-sources/03** defines the payload (`label`, `rank`, `firstSeenAt`, 6 h and 24 h counts, `topTokens`, `summary`, `summarySource`, `computedAt`). A field name changes there, not here; the render test fixture should be generated from 03's response type.
- **viral-sources/04 (Beta finder)** adds Beta Proposals to the Proposals list; a Meta row may later link to the Betas proposed for it. Not in this ticket.
- **Glossary:** Meta, not Narrative; no "trend" noun in the headings (GLOSSARY `_Avoid_` for Meta is Trend), the trend word is a verb-like adjective inside a row, not a name for the thing.
- **Live run:** a 48 h run uses the main checkout and `.data/argus.db`. Work in a worktree and use a `.backup` copy for the browser check.

## Open questions for the Operator

1. **Rows shown.** Top 5 (this ticket). More behind a "show all"?
2. **The 6 h and 24 h views.** Only 24 h is shown, with the 6 h count inside each row. A toggle for a 6 h ranking?
**Decided (user, 2026-11-11):** the per-Meta line is the LLM summary from ticket viral-sources/03 (templated line only as fallback); `/api/signals` and its test may be deleted.

## Commits

One commit, after a full `pnpm check`. Subject `War Room ticket 03: <what changed>` (the earlier redesign tickets use `War Room: ...`), body ending with `Ticket: .scratch/warroom-redesign/issues/03-current-meta-on-home.md` before the trailers. Tick the boxes in the commit only if the full check does not stamp the tree afterwards, otherwise in a follow-up docs commit. No `Closes #N`: this repo has no GitHub issues.

## Comments

### Built, 2026-11-11, branch `meta-home` (on `meta-ranking`, which carries viral-sources/03 Part A)

This ticket file was copied from `main` into the branch to edit it, so expect an add/add on merge: take this version.

- **Depends on** viral-sources/03 slice 5 (the `meta-summary` task, commit `2ced44b`) and its `GET /api/metas` (next commit). Not included: viral-sources/03 slice 2 (theme Metas) and slice 4's judge and propose prompt block; the page shows clone clusters only until slice 2 lands (woohao, 咪好 and NIHAO are separate rows).
- **Files:** `apps/warroom/app/components/CurrentMeta.vue` (template only, rendered by `server/test/current-meta.test.ts`), `app/utils/meta.ts` (trend word, age text, `metaView`, the constants `META_POLL_MS` 60 s, `META_STALE_MS` 2 h, `META_TREND` 0.4 and 0.15), `app/pages/index.vue` (the old section, its `useFetch` and `refreshSignals()` removed; a separate 60 s poll). `server/api/signals.get.ts` and `server/test/signals.test.ts` deleted; `Datastore.latestSignals` stays.
- **Trend word:** the share of the day's launches that fell in the last 6 h; an even rate is 25%, so 40% or more reads accelerating, 15% or less fading, else steady. A Meta first seen 3 hours ago reads accelerating by construction.
- **Links:** none are built in the page. A token links only when the API row carries a `url` (set by `/api/metas` for tokens DexScreener answered for), and only through `UrlLink` after `safeHttpUrl` accepts it. `CurrentMeta.vue` has no `<a>` and no `href` of its own (tested), so the no-raw-href lint of `02-safe-links-everywhere.md` has nothing to flag.
- **Test style:** the render test compiles the real template and server-renders it (as `why-panel.test.ts` does), with `UrlLink` stubbed to the anchor it draws. The fixtures are typed as the API's own `MetasResponse`, and `metaView` takes that type, so a renamed field is a type error in `pnpm typecheck`.
- **Left open:** the `verify:boot` box and the browser-check box. Both need a dev server on a `.backup` copy with a stored Meta run; the chief of staff does them after tonight's restart (no server was started here). `verify:boot` lists pages from `app/pages`, so nothing needed adding.
- Full `pnpm check` on this tree before the commits: 104 files, 1709 tests, passed. It did not stamp (dirty tree), so the boxes are ticked in the commit.

### Ticked on deploy 2026-11-11 (`.scratch/cos.md`)

- `verify:boot` box — "RESTARTED 20:45-03" on 1270357: warroom up on :3100 (pid 46564), `/api/metas` 200, `/api/signals` 404 (route deleted as intended); "DEPLOYED": the home page served in Chrome.
- Browser check box — "DEPLOYED" (~20:50): Chrome check by the chief of staff of the live home page: "Current Meta (last 24h)" with LLM summary lines on ranks 1-4 (ni hao cat, GTA VI, Bernie, BAG), counts, top tokens with links, no Latest signals. Screenshots (outside the repo): `/var/tmp/claude-chrome-screenshots-HRLqut/screenshot-1794440795111-0.jpg` and `-1794440807808-1.jpg`.
- Deviations from the box text, kept honest: the check ran against the live deployed server, not a worktree dev server on a `.backup` copy; no phone-width screenshot and no explicit "nothing overflows / no mid-word truncation" note is recorded; the screenshots are not saved under `.scratch/warroom-redesign/`. A phone-width look is still worth doing. One check covered the API commit and this one (both were on the tree); the API commit was made first and is a subset of it.
