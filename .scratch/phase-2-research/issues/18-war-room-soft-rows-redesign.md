# 18: War Room "Soft Rows" re-skin
**Model:** sonnet / high — presentation-only rewrite of every War Room page and two shared components, plus CSS motion.

**What to build:** Re-skin the War Room (`apps/warroom`, Nuxt) to the Operator-approved "Soft Rows" design on every page. Design source of truth: `.scratch/warroom-redesign/stitch-soft-rows/` (README + screens 01 to 08) and `.scratch/warroom-redesign/figma/soft-rows-list.png`, with the Soft Cards tokens from `.scratch/warroom-redesign/figma/README.md`. Plus Jakarta Sans (self-hosted, no CDN), light grey page background, white rounded surfaces with a soft shadow, indigo accent, soft pills, a single column, a pill nav, a header band of summary surfaces, full-width rounded rows. Details are separate pages (`/proposals/:id`, `/narratives/:id`), never a modal; list rows link to their detail page.

**Status:** done

## Scope

Presentation only. Every existing datum, action, lifecycle rule, form (New Proposal, spec editor, mark launched, rubric) and API call stays functionally identical. No server, API or datastore change. Show only data and actions the current pages already have.

Known drifts of the Stitch images to fix:
- Score bars in list rows are thin horizontal bars (label, track, value), not vertical.
- "New Proposals a day" uses `newProposalsCap` from `GET /api/research`, never the propose run cap.
- No invented text: no Narratives subtitle, no "8 total", no invented spec text or "Target" row.
- Long URLs truncate with an ellipsis and keep a `title` tooltip with the full URL.
- The `collides` pill is amber, as in the approved design.

## Motion

Vue/Nuxt built-ins and CSS only, no motion library. Rows fade and slide in with a short stagger on load (`<TransitionGroup>`), rows lift on hover, score bars grow on mount, list and detail pages cross-fade/slide through a page transition, pills and buttons have subtle state transitions. Durations 150 to 300 ms, ease-out. `prefers-reduced-motion: reduce` disables all of it. Timers and animation setup run only in `onMounted`; SSR must not break.

## Acceptance criteria

- [x] Plus Jakarta Sans is served from an npm package (`@fontsource-variable/plus-jakarta-sans`), no runtime CDN request.
- [x] Shared shell in `app.vue`: brand, pill nav (Proposals, Narratives, Activity, Rubric) with the active state, and a New Proposal pill button that opens the existing New Proposal form on the Proposals page.
- [x] `/` Proposals: header band (research usage with budget and New Proposals bars; Latest Signals), full-width rows with name, ticker, status pill, summary, horizontal score bars with total, collision pills (clear green, collides amber, unknown grey), row actions (Shortlist, Dismiss, Retry Spec, Edit Spec, Re-queue) and every message the page already shows.
- [x] `/proposals/:id`: two-column detail (main: title, status, score, text sections, actions, Narrative link, evidence links, spec editor, launch, build log; side: Score with rationale, Collision checks, Details, Brain runs) with all current fields and actions unchanged.
- [x] `/narratives` and `/narratives/:id`: rows with Signal count and age pills linking to the detail page; detail with Score history, Judge runs, Signals.
- [x] `/activity`: Sources, Narratives, Brain runs, Usage today as soft rows (headings stay `<h3>`), usage bar, "N of cap Proposals today".
- [x] `/rubric`: editable dimension rows, gate sentence, Save Rubric, Discard changes, hard-gate pill.
- [x] Narratives list controls (Operator addition): a bar above the rows in the same pill styling with a sort (Score high to low, the default, unscored Narratives last; Newest; Most Signals; Last Signal) and filters grounded in real data: scored or unscored, has a Proposal or not, Source (any Source with at least one Signal in the Narrative), and activity window (gained a Signal in the last hour, 6 hours, 24 hours, 7 days). A "Clear filters" link appears when a filter is set.
- [x] Sort and filter state lives in the URL query (defaults omitted) and survives reload and back; invalid values fall back to the defaults on the page.
- [x] Sorting and filtering happen in the datastore, not the page: `GET /api/narratives` takes `sort`, `scored`, `proposal`, `source`, `active` and applies the 100-row cap after sorting (the list was capped at 100 of 553 Narratives, so a client-side sort would not give the highest Score overall). New `Datastore.queryNarratives` (and in `WarRoomStore`), rows carry `score` (latest Score total or null) and `hasProposal`; this is an allowed exception to "presentation only". Endpoint tests in `apps/warroom/server/test/narratives.test.ts`: default score order with unscored last and the latest Score counting, each sort, each filter and a combination, the cap applied after sorting, 400 for an unknown sort, filter value or window.
- [x] Motion as described above, disabled under `prefers-reduced-motion`; no timer outside `onMounted`.
- [x] Long URLs truncate with an ellipsis and a `title` tooltip.
- [x] `pnpm check` and `pnpm verify:boot` pass.

**Notes:** the Figma list image shows vertical score bars; the Operator asked for thin horizontal bars, so those win. Row content that the design shows but the page has no data for (for example a per-Proposal Signal count and source) is left out.
