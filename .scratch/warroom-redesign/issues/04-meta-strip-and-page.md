# 04: War Room: a compact Meta strip on home, and a /meta page with the details
**Model:** sonnet / medium — presentation only: the same `/api/metas` payload and `app/utils/meta.ts`, a new strip component, one new page, one nav entry.

**What to build:** the home page's "Current Meta (last 24h)" section (ticket 03) takes too much vertical space. On home it becomes a compact horizontal strip of the top Metas; clicking one opens a new page `/meta` with everything the old section showed, for all Metas.

**Status:** deployed (a059061, f91b825, c670366); browser check and verify:boot boxes open

**Blocked by:** none (03 is deployed, main 1270357).

## Decided by cos (2026-11-11), the user can overrule

- **Strip:** the top 5 Metas of the 24 h ranking, one row, titled "Current Meta". Each is a compact card: rank, Meta label, the momentum pill (accelerating / steady / fading, as today), "N creators · M migrations after 60s", and the top token's market cap. Scrolls horizontally on narrow screens. An "All Metas →" link to `/meta` sits in the strip's header.
- **Click:** a card links to `/meta#<anchor>`. The API carries no group key, so the anchor is derived from the label by a pure function (`meta-` plus the label's letters and digits, hyphenated, at most 40 characters, repeats numbered `-2`, `-3`). No API change.
- **Page `/meta`** (`app/pages/meta.vue`): ALL Metas of the latest run (the API's 50-row cap), each with everything the old section showed: LLM summary, tokens, creators, migrations unfiltered and after 60 s, creates per migration, first seen, 6 h against 24 h, top tokens with `UrlLink`. A 6 h / 24 h toggle (`?window=6h`, a link so it lives in the URL), and the run's `computedAt` ("ranking from 12 minutes ago"), plus the empty and stale notes.
- **Nav:** "Meta" between Narratives and Activity (Proposals, Narratives, Meta, Activity, Study, Rubric).
- Reuse `/api/metas` and `app/utils/meta.ts`; no `v-html`; external links only through `UrlLink`; hostile token names stay text.

## Acceptance

- [x] Home shows the strip (top 5, one row, `data-test="meta-strip"` with `meta-strip-<rank>` cards) instead of the tall section; each card has rank, label, momentum pill, creators and migrations after 60 s, top-token market cap (parts the payload lacks are omitted, never `undefined`/`NaN`); "All Metas →" links to `/meta`; the row scrolls horizontally (`overflow-x-auto`).
- [x] Each card links to `/meta#<anchor>`, and the same anchor is the `id` of that Meta's row on the page; `metaAnchor` is a unit-tested pure function (unicode labels, empty, hostile, repeats, clamp).
- [x] `/meta` lists every Meta of the run with the old section's content plus migrations after 60 s; the window toggle links to `?window=6h` / `24h` and the numbers follow the ranked window; shows `computedAt` as a footer; empty and stale states render.
- [x] "Meta" is in the nav, lit on `/meta`.
- [x] Hostile payload (markup, `</script>`, `javascript:` URL, 10,000 characters) renders as clamped text in strip and page, no unsafe `<a>`, no raw HTML, no `v-html`.
- [x] Home polls `/api/metas` every 60 s, not 3 s (unchanged); the page does too.
- [ ] `verify:boot` still healthy (page list generated from `app/pages`).
- [ ] Browser check by cos after merge: desktop and phone width, strip scroll, anchor jump from a card.
- [x] Full `pnpm check` passes once on the committed clean tree.

## Commits

One commit after the tests are green, subject `War Room ticket 04: <what changed>`, body ending with `Ticket: .scratch/warroom-redesign/issues/04-meta-strip-and-page.md`. Boxes ticked in a follow-up docs commit if `pnpm check` stamps the clean tree.

## Comments

### Built, 2026-11-11, branch `meta-strip` (worktree cut from main b7186d3, which only adds docs commits over 1270357)

- **Files:** `app/components/MetaStrip.vue` (new, home), `app/components/MetaList.vue` (was `CurrentMeta.vue`, now the /meta body: no title or surface wrapper, rows are `id`'d by anchor), `app/pages/meta.vue` (new), `app/pages/index.vue` (strip in place of the section; the research band renders only when there is research data), `app/app.vue` (nav), `app/utils/meta.ts` (`metaAnchor`, `anchor`/`stripLine`/`topCap` per row, `metaView` options `rows` and `window`, "N after 60 s" in the numbers), tests `server/test/meta-view.test.ts` and `meta-render.test.ts` (was `current-meta.test.ts`).
- **Anchor:** derived from the label, as decided; a label change between runs changes its anchor. A stable group key in `/api/metas` would be the fix if that matters.
- **Window toggle:** `?window=6h` re-fetches `/api/metas` with that window; the numbers follow the ranked window, the trend text stays "6 h of 24 h".
- **Left open:** the browser check (cos, after merge).
