# 12: War Room: the header nav is clipped at phone width, so four pages cannot be reached
**Model:** sonnet / medium. One header block and one CSS rule, no data model; the approach is chosen below and the check is `pnpm page:check`.

**What to build:** at 390 px the header nav pill on every War Room page shows "Proposals, Narratives, Meta, Ac..." inside an oversized white rounded box under the title and the New Proposal button. Activity, How it works, Study and Rubric cannot be reached. Home also reports horizontal overflow (`scrollWidth` 404 > 390). Seen 2026-11-15 with `pnpm page:check` at 390 px against the live :3100, main 02b936d. Ticket 10 slice a added the "How it works" item (seventh), which made it worse. Make every nav item reachable at 390 px by touch and keyboard, with the active page visible, and leave 1240 px as it is.

**Status:** open

**Blocked by:** none.

## What is there today (read 2026-11-15)

- `apps/warroom/app/app.vue:19`: `<header class="mb-10 flex flex-wrap items-center justify-between gap-x-6 gap-y-4 lg:grid lg:grid-cols-[1fr_auto_1fr]">`. Below `lg` (1024 px) it is a wrapping flex row: title, then the New Proposal button (`:26`), with the nav pushed to its own row by `order-last w-full`.
- `app.vue:21`: `<nav class="order-last flex w-full gap-1 overflow-x-auto rounded-full bg-white p-1.5 shadow-[var(--wr-shadow)] lg:order-none lg:w-auto">`. The pill is full width, `overflow-x-auto` and `rounded-full`, so seven items that need roughly 700 px are meant to scroll sideways.
- `apps/warroom/app/assets/css/main.css:364`: `.nav-pill { display: inline-flex; padding: 10px 20px; ... }` has no `flex-shrink: 0` and no `white-space: nowrap`. As flex items they shrink and the labels wrap or clip instead of overflowing the container, so the `overflow-x-auto` never has anything to scroll. Likely the real cause of the clipped "Ac..." and the tall white box (a wrapped label doubles the pill height). The scrollbar is also not designed: it either shows a default bar or is invisible, and nothing hints that more items exist.
- The home `scrollWidth` 404 may come from this header or from page content under it. The worker confirms which element is widest (`page:check` JSON, or a read-only evaluate in a throwaway script) before changing anything, and records it in Comments.
- `app.vue:3` `NAV` (seven items) and `active()` stay as they are; "Proposals" is lit on `/proposals/...`, "Narratives" on a Narrative's page.

## Constraints

- Soft Cards / Soft Rows style (`.scratch/warroom-redesign/figma/README.md`): white pill, rounded-full, `var(--wr-shadow)`, the existing `.nav-pill` look and `is-active` tint.
- Motion with Vue built-ins only (`<Transition>`, `<TransitionGroup>`) or plain CSS transitions already in the file. No new UI library or dependency. `UApp` stays.
- All seven items reachable at 390 px by touch (swipe or tap) and keyboard (Tab reaches each link in order; a focused link is scrolled into view; `:focus-visible` ring not clipped by the pill).
- The active page stays visible at 390 px on load, without the user scrolling to find it.
- Desktop (1240 px) layout unchanged: same grid, same pill, same positions. Compare the new 1240 screenshots to the 2026-11-15 ones; do not change anything under `lg:`.
- Do not edit `scripts/warroom-pages.mjs` route lists beyond what a test needs. Do not touch the live Argus or `.scratch/cos.md`.

## Options (the ticket writer's recommendation, the user can overrule)

1. **Scrollable pill row (recommended).** Keep the markup. Add `shrink-0 whitespace-nowrap` to `.nav-pill` (or `flex-shrink: 0; white-space: nowrap`), keep `overflow-x-auto` on the `<nav>`, hide the scrollbar (`scrollbar-width: none`, `::-webkit-scrollbar { display: none }`), add `min-w-0` / `max-w-full` so the nav cannot widen the header, and a small script in `app.vue` that scrolls the active link into view on mount and on route change (`el.scrollIntoView({ inline: "center", block: "nearest" })`, with `behavior: "auto"` when `prefers-reduced-motion`). A right-edge fade (a CSS mask on the nav below `lg`) tells touch users there is more. Smallest change, keeps one tap per page, and a keyboard Tab scrolls each link into view by itself.
2. **Compact menu button.** Below `lg`, show the active label with a chevron in the pill; tapping opens a Soft Cards sheet listing the seven items (a `<Transition>` fade/slide). Every item is visible at once and larger to tap, but it costs two taps per page, needs focus handling (Escape closes, focus returns to the button) and a second markup path for the same `NAV`. More code and more to test for the same result.

Recommendation: option 1. Take option 2 only if option 1 at 390 px still reads as cramped on the screenshots.

## Acceptance

- [ ] The cause is named in Comments with the widest element for the home overflow (selector and width), before the fix.
- [ ] `pnpm page:check <path>` at 390 px for `/`, `/meta`, `/pipeline` and `/proposals` shows no horizontal-overflow warning caused by the header or nav (a documented sideways scroll of the `/pipeline` graph itself, ticket 10, still prints and is not this ticket's). Exit 0. Cite the four 390 px screenshots: one pill row on one line, no wrapped label, the active item visible.
- [ ] Every nav link reachable at 390 px by keyboard: `pnpm page:check / --keys "focus=nav[aria-label=Main] a,Tab,Tab,Tab,Tab,Tab,Tab" --watch 'nav[aria-label=Main] a[aria-current]'` (adjust the selector; Tab steps only, no Enter) shows the focus landing on all seven links in order, and the `-390-keys.png` screenshot of the last step shows "Rubric" fully visible. Do the same for `/pipeline` so the active "How it works" is visible without any key.
- [ ] Touch reach: the nav `scrollWidth` exceeds its `clientWidth` at 390 px only through the scroll the pill provides (nothing is hidden behind an unreachable edge), and the fade or an equivalent cue is visible in the screenshot.
- [ ] 1240 px screenshots of the same four pages are unchanged from before the fix (state this by looking at both; the header grid and pill look the same).
- [ ] `scripts/warroom-pages.test.ts` still passes. If the header gains any logic worth a test (the scroll-active-into-view helper), put the pure part in `apps/warroom/app/utils/` with a fast test.
- [ ] Full `pnpm check` passes once on the committed clean tree.

## Commits

One commit after the full `pnpm check`. Subject `War Room ticket 12: <what changed>`; the body ends with `Ticket: .scratch/warroom-redesign/issues/12-header-nav-at-phone-width.md` before the trailers. No `Closes #N`: this repo has no GitHub issues. No GLOSSARY.md line expected.

## Open questions

1. **Scrollable row or menu button?** Default: option 1, the scrollable pill row with a fade cue. Overrule if you prefer a menu button. **Answered 2026-11-15: swipeable pill row (option 1), not a menu button.**
2. **Breakpoint:** keep the existing `lg` (1024 px) switch, so tablets (768 px) get the same scrollable row, or give the row its full width only below `md`? Default: keep `lg`, no new breakpoint. **Answered 2026-11-15: keep the `lg` desktop breakpoint and layout unchanged.**

## Comments

### 2026-11-15: user answers

1. Swipeable pill row (option 1), not a menu button.
2. Keep the `lg` desktop breakpoint and layout unchanged; no new breakpoint.

Both open questions are answered; the ticket is ready to implement as option 1.
