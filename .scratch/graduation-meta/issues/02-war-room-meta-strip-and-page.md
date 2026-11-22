# 02: War Room Meta strip and page show graduations
**Model:** sonnet / medium — view and formatting work on an existing page with a render test.

**What to build:** Show the new rule in the War Room (`apps/warroom/app/pages/meta.vue`, `CurrentMeta.vue`, `utils/meta.ts`, server `current-meta.get.ts`). Each Meta reads "Christmas: 10 graduated in 24h (3 in the last 6h), 10 creators, 10% of all graduations". Below it, the 3 newest graduate names, each with the leader price if known (a dash if not), and the theme chips. A thin window shows a coverage flag ("covered 5 of 24 h"). A Watching subject gets a "rising: 3 in 6h" badge when it qualifies by the 6 h rule. The Meta page gets a new intro explaining that a Meta is several tokens graduating on one narrative, not one big coin. All text is plain text.

**Blocked by:** 01

**Status:** done

- [x] A render test on the Christmas fixture shows the sentence above, the 3 newest graduate names and the theme chips.
- [x] An unpriced leader shows a dash.
- [x] A thin window shows the coverage flag; a full window does not.
- [x] A Watching subject with 3 in 6 h shows "rising: 3 in 6h".
- [x] Plain text only: no `v-html`, no raw bound `:href` (`UrlLink` / `safeHttpUrl` for links).
- [x] The new page intro is present.
- [x] `pnpm page:check` exit 0 at both widths (1240 and 390 px), screenshots cited, `--seed` named if used.
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Notes
- Reads the per-subject `{24h, 6h, creators24h, share}` kept by ticket 01 in the counts JSON.
- Spec: `.scratch/graduation-meta/spec.md`.
