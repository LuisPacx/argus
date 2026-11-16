# 15: relative times render from one client-only clock (no hydration mismatch)
**Model:** sonnet / medium. A small composable plus a one-argument change in the pages that already pass `nowMs` to pure view functions; no schema, ADR or dependency change. The test uses the existing `renderToString` pattern in `apps/warroom/server/test/*-render.test.ts`.

**What to build:** every relative time on the War Room ("40 minutes ago", "Expires in 12 min", "closes in 3 h", "last checked 12 s ago") is computed from a shared clock that is `0` on the server and on the first client render, and set to the real time on mount. Until then the text is an absolute UTC time, the same on both sides. Approved by the user 2026-11-16 (`.scratch/cos.md`, "yes relative-time ticket").

**Status:** done

**Blocked by:** none. (Follows 14, whose seeded runs exposed it.)

## Why

- The server renders "40 minutes ago" from its `Date.now()`; the browser hydrates from its own `Date.now()` a moment later. When a minute boundary falls between the two, the text differs and Vue logs "Hydration completed but contains mismatches" (ticket 14 Comments; `cos.md` "WR/14 REVIEW"). Seeded `pnpm page:check --seed --all` hits this about 1 run in 20, and it can happen on live pages for any visitor.
- `pages/activity.vue` already does it right (`nowMs = ref(0)`, set in `onMounted`, absolute `clockTime` until then). The other pages start from `ref(Date.now())`.

## What is there today (read 2026-11-16)

Pure formatters, all taking `nowMs` (so they stay pure and testable):

- `utils/meta.ts`: `ageText(iso, nowMs)` (the one shared "just now / N minutes / hours / days ago"), used by `rowView`, `metaView` (footer "ranking from ..."), `currentRowView` (`enteredAt`, `newMeta.raisedAt`), `currentMetaView` (footer "computed ..."); the stale notes in `metaView` and `currentMetaView` ("stale (computed N hours ago)") also use `nowMs`.
- `utils/new-meta.ts`: `newMetaView` (`raisedAt`, news `publishedAt`) via `ageText`.
- `utils/meme.ts`: `memeView` (trigger age, newest Signal, ranking age, news `publishedAt`: four `ageText` calls), `ideaViews` ("closes in N min", from `expiresAt - nowMs`).
- `utils/build-notice.ts`: `checkedAge` ("12 s ago", "3 min ago", "2 h ago") via `buildNoticeView(p, nowMs)`.

Callers that own a clock:

- `pages/index.vue:113`: `nowMs = ref(Date.now())`, passed to `currentMetaView`, `newMetaView`; also `timeLeft()` ("Expires in N min") and `narrativeAge()` read it directly.
- `pages/meta.vue:15`: same, passed to `metaView`, `currentMetaView`, `newMetaView`.
- `pages/narratives/index.vue:71`: same; `age()` reads it directly.
- `pages/proposals/[id].vue:31` and `:34`: `memeView(p.value, Date.now())` and `buildNoticeView(p.value, Date.now())`, no clock ref at all (never ticks).
- `pages/activity.vue:13`: already correct (0 until mounted); only its `ago()` and `duration()` text differs in style.

## Design (the ticket writer's choice, the user can overrule)

Chosen: **one shared clock, not a `<RelativeTime>` component.** Most relative text is built inside the pure view functions as part of a longer string ("raised 3 hours ago", "closes in 12 min"), so a component would have to split every view string; a clock argument changes nothing in their shape. A component is the better fit only for a bare `<time>` element; there is none today.

- New `app/composables/useNowMs.ts`: `useNowMs(intervalMs = 30_000): Ref<number>`. Returns `ref(0)`, sets `Date.now()` in `onMounted`, ticks on the interval, clears it in `onBeforeUnmount`. `0` means "not mounted yet".
- `ageText(iso, nowMs)`: when `nowMs <= 0` and `iso` parses, return the absolute UTC text from a fixed-locale formatter in `utils/format.ts` (e.g. `6 Nov 23:49 UTC`, `Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ... })`, so the server's and the browser's time zone cannot matter). Callers' phrases stay: "ranking from 6 Nov 23:49 UTC", "raised 6 Nov 23:49 UTC". The special-case `age === "just now"` branches are unaffected (the absolute text is never "just now").
- Stale notes (`metaView`, `currentMetaView`): with `nowMs <= 0` skip the stale check (the existing `nowMs - computedMs > META_STALE_MS` is already false for `0`); the note appears after mount.
- Countdown text (`ideaViews`, `timeLeft`, `buildNotice`'s `checkedAge`, `narrativeAge`, narratives `age`): with `nowMs <= 0` show the absolute UTC deadline or time ("closes 17 Nov 04:10 UTC", "Expires 17 Nov 04:10 UTC", "last checked 04:10:02 UTC", "started 6 Nov 23:49 UTC") instead of the relative form.
- Pages replace `ref(Date.now())` and their own `setInterval`/`onMounted`/`onBeforeUnmount` with `useNowMs()`; `proposals/[id].vue` passes `useNowMs()` instead of `Date.now()` (it now also ticks; one `setInterval`).
- `activity.vue`: switch to `useNowMs(1_000)` and drop its own timer code (same behavior; optional if it makes the diff noisy, but then the pattern lives in two places).

## Call sites to change (11)

1. `app/utils/meta.ts`: `ageText` (the `nowMs <= 0` branch), the two stale-note checks in `metaView` and `currentMetaView`.
2. `app/utils/meme.ts`: `ideaViews` expiry text.
3. `app/utils/meme.ts`: `memeView` (four `ageText` calls; no change to the calls if `ageText` handles it, listed so the test covers them).
4. `app/utils/build-notice.ts`: `checkedAge`.
5. `app/utils/format.ts`: new fixed UTC formatter helper (also used by 1 to 4).
6. `app/composables/useNowMs.ts`: new.
7. `app/pages/index.vue`: `nowMs`, `timeLeft`, `narrativeAge`.
8. `app/pages/meta.vue`: `nowMs`.
9. `app/pages/narratives/index.vue`: `nowMs`, `age`.
10. `app/pages/proposals/[id].vue`: the two `Date.now()` calls.
11. `app/pages/activity.vue`: swap its hand-made clock for the composable (optional, see above).

`utils/new-meta.ts` needs no edit (it only calls `ageText`); its test covers it.

## Constraints

- The view functions stay pure: no `Date.now()` inside `utils/`. The only `Date.now()` is in the composable.
- No `ClientOnly` wrapper: the card's box stays in the server HTML, so there is no layout jump from a missing block, only a text swap.
- 390 px: the absolute text is a little longer than "5 min ago". Every place that shows it must wrap, not push the page wide (`min-w-0`, `break-words` as the cards already do); check with the seeded run at 390.
- Never `new RegExp(x)`; no `sed`/heredoc edits; one command per Bash call; no `/tmp` writes (`worker-rules.md`). Live processes untouched; browser boxes use `pnpm page:check --seed` and say the run was seeded.

## Acceptance

- [x] A test proves the server render and the first client render give the same markup: for each of `/`, `/meta`, `/narratives`, `/proposals/<tech>`, `/proposals/<meme>` (`memeView` + `buildNoticeView`), render the page (or the shared card components) with `nowMs = 0` twice, with `Date.now` stubbed to two different minutes, and assert the two strings are equal and contain no "ago". A second assertion: with `nowMs` set to a real time the text is the relative form. For `ageText`, `ideaViews` and `checkedAge`: unit tests for the `nowMs <= 0` branch (absolute UTC text, identical whatever `TZ` is set to).
- [x] A test that no `Date.now()` / `new Date()` call remains in `app/utils/{meta,meme,new-meta,build-notice}.ts` (a source scan, like the repo's other guard tests), so the bug cannot return unseen.
- [x] `pnpm page:check --seed --all` passes 10 runs in a row with no hydration errors: each run exits 0 with 0 console, page and failed-request errors (the JSON `"seeded": true`), and no "Hydration completed but contains mismatches" line. Cite the ten exit codes in Comments. Run them one after another, never in parallel, and say in the box that the runs were seeded.
- [x] 390 px has no overflow: in those runs the 390 px overflow check passes on every page (it fails a seeded run on all pages except `/pipeline`), including the hostile-string card. Screenshot paths cited.
- [x] Type-check, `pnpm lint` and the full `pnpm check` pass once before the commit.

## Commits

One commit after the full `pnpm check`. Subject `War Room ticket 15: relative times from one client-only clock`; body ends with `Ticket: .scratch/warroom-redesign/issues/15-relative-times-client-only.md` before the trailers. No `Closes #N`. No GLOSSARY.md or ADR change.

## Open questions (recommended answers; the user can overrule)

1. **Shared clock or a `<RelativeTime>` component?** Recommended: the shared clock (design above); the text lives inside view strings, not in standalone elements. Add a component later only if a bare `<time>` appears.
2. **What does the first render show: absolute UTC text, or nothing?** Recommended: absolute UTC text (as `activity.vue` does), so the card never loses information before JS runs. UTC rather than the viewer's zone, because the server cannot know the viewer's zone.
3. **`fmtWhen` (`utils/format.ts`) has the same class of bug**: it formats in the host's time zone and reads `new Date().getFullYear()`; the server and the browser can differ if their zones differ (used on `proposals/[id].vue` and `narratives/[id].vue`). Fix here or separately? Recommended: separately, a follow-up ticket; it is a time-zone problem, not a clock-tick one, and this machine's server and browser share a zone, so no seeded run shows it.
4. **Tick rate.** Recommended: keep 30 s for every page but `activity.vue` (1 s, it shows seconds); the proposal page gains a 30 s tick it did not have, which is harmless.
5. **Stale notes appear after mount, not in the server HTML.** Recommended: accept; a stale note flashing in a moment after load is better than a mismatch, and the ranking footer already shows the age.

## Comments

- **Written 2026-11-16** after the user's approval ("yes relative-time ticket", `cos.md` 11-16 USER).
- **Decisions 2026-11-16:** the user accepted every recommended answer to the five open questions: (1) shared clock, no `<RelativeTime>` component; (2) absolute UTC text on the first render; (3) `fmtWhen` time zone stays a separate follow-up ticket, not done here; (4) 30 s tick everywhere except `activity.vue` (1 s); (5) stale notes appear after mount.
- **Done 2026-11-16.** `useNowMs()` (`app/composables/useNowMs.ts`, 0 until mounted) now feeds index, meta, narratives, proposal and activity pages; `ageText`, `ideaViews`, `checkedAge` and the page countdown helpers show absolute UTC text (`fmtUtc`, `fmtUtcClock` in `utils/format.ts`) while the clock is 0. Tests: `apps/warroom/server/test/relative-times.test.ts` (view text equal under two stubbed `Date.now()` values and no "ago", relative form with a real clock, TZ-independent UTC text, stale note waits, source scan of utils and pages). The tests render the view functions, not full page components. Seeded `pnpm page:check --seed --all`, 10 runs one after another: exit codes 0 0 0 0 0 0 0 0 0 0; every run 8 pages, each "console errors: 0, page errors: 0, failed requests: 0"; no "Hydration" line in any run. Screenshots in `/var/tmp/page-check/` (for example `proposals-4-390.png`, `proposals-5-390.png`). Boxes left for cos.
- 2026-11-16: boxes ticked on review (MERGE) + verifier (check 2438, 3x page:check --seed --all no Hydration); the first-markup test covers view functions, not whole pages.
