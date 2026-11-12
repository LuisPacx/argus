# 06: War Room: the home "Research usage" card becomes one compact full-width bar
**Model:** sonnet / medium — presentation only: the same `/api/research` payload, one pure view function, one new component, and the card in `index.vue` replaced.

**What to build:** the home card "Research usage, last 24 hours" is half the content width, tall and wordy. It becomes one short bar, 100% of the content width, directly under the Meta strip. Every number it shows today stays available.

**Status:** open

**Blocked by:** none (04 is on main, f91b825).

## Decided by cos (2026-11-12), the user can overrule

- **Bar:** label "Research 24h"; "$1.67 / $6.00" (Est. usage against the budget) with a thin progress bar; "Proposals 3 / 30" with a thin progress bar; the API spend as short muted text ("API $0.0000 / $5.00"). One row on wide screens, wrapping on phones.
- **Details:** the long sentences (the judge and propose runs and the quota percentages, the Est. usage and API-spend explanations, the fallback-off instructions) move into a small "details" disclosure (`<details>`) inside the bar, plus `title` tooltips on the labels. Nothing is inline except the short alerts below.
- **Alerts stay inline, short, amber:** research budget reached, API daily cap reached, new-Proposal cap reached (these are state, not explanation).
- **Look:** like `MetaStrip.vue`: `surface`, `track`/`fill` bars, `muted`/`faint`, tabular numbers. No `v-html`. Polling stays 3 s (unchanged).
- **Code:** `app/utils/research-bar.ts` (pure `researchBar(research)` view) and `app/components/ResearchBar.vue` (template-only); `index.vue` renders the component where the card was, and `data-test` hooks `research-usage`, `proposal-cap`, `api-spend` are kept.

## Acceptance

- [ ] Home shows one full-width bar (`data-test="research-usage"`) under the Meta strip instead of the half-width card; it has the label, the budget amount and bar, the proposals count and bar, and the API spend text, and is one short row (no paragraphs inline).
- [ ] Every number of the old card is still in the output: used, budget, proposals n of cap, judge and propose runs, share of the assumed quota, quota, limit share, API used, API cap, API runs; the explanatory sentences are inside `<details>` or a `title`, not inline.
- [ ] The three alerts render inline only when their flag is set; the fallback-off hint shows only when the fallback is off (inside the details).
- [ ] `researchBar` is a unit-tested pure function; the component has a render test over the real template; singular/plural ("1 run"), zero budget and over-100% values do not give `NaN` or a bar wider than 100%.
- [ ] No `v-html`; the bar adds no external link.
- [ ] Full `pnpm check` passes once on the committed clean tree.
- [ ] Browser check by cos after merge: desktop and phone width, details disclosure, the bar's height against the old card.

## Commits

One commit after the tests are green, subject `War Room ticket 06: <what changed>`, body ending with `Ticket: .scratch/warroom-redesign/issues/06-compact-research-usage.md`. Boxes ticked in a follow-up docs commit if `pnpm check` stamps the clean tree.

## Comments
