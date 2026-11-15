# 13: War Room: the home page scrolls sideways at phone width, and the nav pill loses its shadow
**Model:** sonnet / medium. Two CSS/markup fixes in known files, no data model; the check is `pnpm page:check`.

**What to build:** at 390 px the home page `/` still scrolls sideways: `pnpm page:check /` prints `WARN 390px: horizontal overflow (scrollWidth 404 > viewport 390)`. Ticket 12 fixed the header nav and left this as content under it. Make `/` fit 390 px with every control still usable, and fix the nav pill's clipped shadow, a cosmetic leftover from ticket 12. Leave 1240 px as it is. Seen 2026-11-15, main 665ba50, live :3100.

**Status:** done

**Blocked by:** none.

## What is there today (read 2026-11-15)

- `pnpm page:check /` against the live :3100: 1240 px `scrollWidth` 1240, no overflow; 390 px `scrollWidth` 404 > 390, overflow warning. Exit 0, no console, page or request errors.
- Measured at 390 px with a read-only Playwright evaluate (page content is 350 px wide: 390 minus `px-5`, `app/app.vue:32`). The `grid gap-8` root of `pages/index.vue:205` and its children (title, Current Meta section, controls) are 379 px wide, right edge 399. The grid track is stretched by its widest child's min-content (grid items default to `min-width: auto`).
- Widest child: `ListControls` (`app/components/ListControls.vue:12`, `flex flex-wrap`), whose first `.seg` is 379 px wide (right 399). That is the Sort group, built by `SegmentedLinks.vue:8` from `pages/index.vue:58`. `.seg` is `display: inline-flex` with `.seg-item { white-space: nowrap }` and no wrap or scroll (`assets/css/main.css:579`, `:587`), so it cannot shrink below its options' total. The Collisions `.seg` is 278 px and fits; the two `select-pill`s (143 and 106 px) fit. `ListControls` is also used by `pages/narratives/index.vue:99`.
- The Current Meta strip, `MetaStrip.vue:18` (`ol.-mx-1 flex snap-x overflow-x-auto px-1`), is 387 px wide, right 403, because it sits in the same stretched 379 px column. It is its own horizontal scroller (items `min-w-[13.5rem]`, running past 900 px), so its scrolling is intended; it only needs the column to stop being 379.
- Ticket 12's Comments also named a ~399 px `svg` in ListControls. Not confirmed: there is no svg in `ListControls.vue` or the home page. The only svgs in `app/components` are `UrlLink.vue:9` (3.5 px icon) and `PipelineGraph.vue:16` (the `/pipeline` page). The 399 is the right edge of the 379 px column, not an svg width.
- Nav shadow: `app/app.vue:35` puts `shadow-[var(--wr-shadow)]` and `overflow-x-auto` on the same `<nav class="nav-row">`. `main.css:372` applies `mask-image` to `.nav-row` below `lg`, and a mask clips everything outside the element's box, so the pill's outer box-shadow is cut off and the pill looks flat at 390 px.

## Constraints

- Soft Cards / Soft Rows style (`.scratch/warroom-redesign/figma/README.md`): `.seg` keeps its pill look, `var(--wr-shadow)` and the `is-active` tint. No new UI library or dependency; `UApp` stays.
- Desktop (1240 px) unchanged: same layout and positions. Scope new rules to below `lg`/`sm`, or use utilities that do nothing at 1240 (such as `min-w-0`).
- `/narratives` also uses `ListControls`; it must not regress (check it at 390 and 1240 too).
- Nav tweaks from ticket 12 stay: nowrap pills, hidden scrollbar, right-edge fade, end spacer, scroll-active-into-view, focus ring.
- Do not touch the live Argus or `.scratch/cos.md`.

## Approach (the ticket writer's recommendation, the user can overrule)

1. **Page width.** Stop the grid track from growing: `min-w-0` on the `grid gap-8` children, or `grid-cols-[minmax(0,1fr)]` on the root (`pages/index.vue:205`, and the narratives page root if it has the same shape).
2. **Controls: wrap, not scroll.** Let `.seg` wrap below `sm`: `flex-wrap` with `max-width: 100%` and the pill radius reduced so a wrapped second line still looks like a card (for example `border-radius: 1.25rem` when wrapped; one rule, below `sm`). Reason to wrap rather than scroll: this is a choice among options, so every option should be visible at once without a swipe, and a nested horizontal scroller inside a page that also has the Current Meta strip and the nav row would be a third sideways scroll on one screen. If the screenshot shows the wrapped Sort group reading badly, fall back to `overflow-x-auto` on the `.seg` with the same fade cue as the nav.
3. **Nav shadow.** Keep the `<nav>` as the shadowed, rounded white box (no mask on it). Move the mask to a second, small inner wrapper that holds the scrolling pill row, so the mask clips only the scrolling content and the shadow stays outside it. Only the box that scrolls (and its fade) is masked; the nav's box-shadow, `rounded-full` and `bg-white` stay on the outer element. Keep `aria-label="Main"` on the `<nav>`; make sure the `scrollIntoView` helper and the `focusin` handler (`app.vue:16-27`) point at the element that actually scrolls.

## Acceptance

- [x] The cause is stated in Comments before the fix, with the widest element and width (the Sort `.seg`, 379 px) and the selector used.
- [x] `pnpm page:check /` has no horizontal-overflow warning at 390 px (`scrollWidth` 390), exit 0, no console, page or request errors; the Current Meta strip still scrolls sideways inside itself.
- [x] `pnpm page:check /narratives` at 390 px has no new overflow warning and its 1240 px screenshot is unchanged.
- [x] All controls usable at 390 px: Sort and Collisions options each visible and tappable, Status and Created selects usable, Clear filters reachable. Decision (wrap or scroll) and its reason are recorded in Comments, with the 390 px screenshot.
- [x] 1240 px screenshot of `/` unchanged from before the fix (state this by looking at both).
- [x] Nav shadow visible at 390 px: the pill shows the same soft shadow as at 1240 px in `home-390.png`; the right-edge fade and swipe still work, and the Tab check from ticket 12 still passes (`pnpm page:check / --keys "focus=nav[aria-label=Main] a,Tab,Tab,Tab,Tab,Tab,Tab" --watch 'nav[aria-label=Main] a[aria-current]'`, Rubric fully visible in the last `-390-keys.png`).
- [x] Full `pnpm check` passes once on the committed clean tree.

## Commits

One commit after the full `pnpm check`. Subject `War Room ticket 13: <what changed>`; the body ends with `Ticket: .scratch/warroom-redesign/issues/13-home-page-width-at-phone.md` before the trailers. No `Closes #N`: this repo has no GitHub issues. No GLOSSARY.md line expected.

## Open questions

1. **Wrap or scroll the Sort group?** Default: wrap below `sm` (see Approach 2). Overrule if you prefer a swipeable row.

## Comments

- **Decision (user, 2026-11-15): WRAP the Sort group below sm** (the recommendation), and fix the nav shadow by moving the mask to an inner wrapper. Reason for wrap: a choice among options should show every option at once, and a nested scroller would be a third sideways scroll beside the Current Meta strip and the nav row.
- **Cause (before the fix):** widest element is the Sort `.seg` (`ListControls` first child, built by `SegmentedLinks`), 379 px, right edge 399; `.seg-item` is `white-space: nowrap` and the `.seg` could not shrink, so the `grid gap-8` track of `pages/index.vue` grew to it (grid items `min-width: auto`). `pnpm page:check /` before: 390 px `scrollWidth 404 > 390`.
- **Fix:** `grid-cols-[minmax(0,1fr)]` on the `/` grid root; `.seg` below sm (`max-width: 639.98px`) gets `flex-wrap: wrap; max-width: 100%; border-radius: 1.25rem`; nav: the `<nav aria-label="Main">` keeps `rounded-full bg-white shadow`, and the scrolling row moved to an inner `div.nav-scroll` (mask, hidden scrollbar, end spacer, `p-1.5`); the `ref`/`scrollIntoView` and `focusin` handler are on that inner div.
- **Evidence** (own War Room on :3213, sqlite3 `.backup` copy, stopped and deleted after; screenshots in `/var/tmp/claude-1000/-home-unknown-code-argus/07489f29-acfe-4e1e-8952-676b677ef955/scratchpad/{before,after,after-keys}/`):
  - `/` after: no overflow warning at 390 (and 1240), exit 0, console/page/request errors 0. Before: 404 > 390 warning.
  - 390 px screenshot `after/home-390.png`: Sort wraps to two lines (Score, Newest, Recently changed / Est. usage) in a rounded card, all options visible; Kind, Collisions, Status and Created selects fit; Current Meta strip still scrolls inside itself (cards run off the right edge).
  - 1240 px `/`: `before/home-1240.png` and `after/home-1240.png` looked at side by side, same layout and positions.
  - `/narratives` before and after: identical warnings (1240 scrollWidth 1349, 390 scrollWidth 1229), so no new overflow; that overflow predates this ticket and has another cause (not in scope). `/meta` clean before and after; `/pipeline` 390 overflow 501 identical before and after (pre-existing). Screenshots for all under before/ and after/.
  - Nav shadow visible at 390 px in `after/home-390.png` (pill shows the same soft shadow as at 1240), right-edge fade present.
  - Tab check from ticket 12 (`after-keys/`): exit 0, every focused link and the active link visible at 390 and 1240; Rubric fully visible in `after-keys/home-390-keys.png`.
  - Clear filters: no filters are applied on this data, so it is not rendered; its markup is unchanged and sits in the same wrapping `ListControls` flex.
