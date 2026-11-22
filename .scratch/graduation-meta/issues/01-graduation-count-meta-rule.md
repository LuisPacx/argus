# 01: Graduation-count Meta rule, so several tokens graduating on one narrative make a Meta
**Model:** sonnet / high — rule change across store, compute, leaders and config with many edge cases and adapted tests.

**What to build:** Replace the leader-market-cap rule with a graduation-count rule (spec sections 1 and 2). Add a read-only `StudyStore.graduatedBetween(fromIso, toIso)` on the `migrated_at` index. In `compute.ts`, match graduates to AI subjects by name/ticker key forms (`tokenSubjectForms` / group keys); an ambiguous match joins no subject. A subject is a Meta at 10 or more graduations in 24 h, 6 or more distinct creators and 3 or more in the last 6 h; it stays at 5 or more in 24 h with state carried for `stateMaxMinutes` (120). Max 3 Metas ranked by 24 h graduations, then 6 h, then creators. Watching is not-a-Meta with 5 or more in 24 h or 3 or more in 6 h, top 3 by 6 h then 24 h. Market cap leaves the rule: the leader is the highest-priced graduate, else the latest graduate with the cap shown as a dash; downstream types are unchanged. Trending lists no longer create Metas (fake-token screening stays for that list). Keep per-subject `{24h, 6h, creators24h, share}` in the existing counts JSON. Add the six `ARGUS_META_*` keys with `intIn()` in `meta/config.ts` (`metaMinGrads=10`, `metaStayGrads=5`, `metaMinCreators=6`, `metaLiveGrads6h=3`, `watchMinGrads=5`, `watchGrads6h=3`). Price fix: theme-token pricing skips the $50k liquidity/volume floors (cap/liquidity ratio only when liquidity is above 0), and `candidates()` asks for the newest graduated tokens, not the oldest 30. Thin windows (stream gaps, `study_gaps`) still qualify but carry a coverage flag via `metaCoverage()`.

**Blocked by:** none

Status: needs-info
- [x] `graduatedBetween` is read-only, uses the `migrated_at` index and writes nothing.
- [x] A fixture subject with 10 or more graduations, 6 or more creators and 3 or more in 6 h and no priced leader is a Meta with the cap shown as a dash.
- [x] 9 graduations make it Watching, not a Meta.
- [x] 10 graduations by one creator are not a Meta.
- [x] A Meta stays at 5 graduations, drops at 4, and its state is carried for `stateMaxMinutes`.
- [x] Christmas fixture (themes santa, snowball, xmas, grinch, goonmas, christmas, bullmas, holdmas, pepemas, catemas, fomomas; graduates Bullmas, snowball, ChristmASS, Santa Inu, Snowball, CATEMAS, snowball-v2, Saint Nicholas SANTA, pepesanta, Christmas Inu; 10 creators, 3 in the last 6 h) gives one Meta "Christmas" with 10 in 24 h, 3 in 6 h and 10 creators.
- [x] A late graduate of an old create is counted; a bonk graduation is not.
- [x] `maxMetas=3` ranks by graduations.
- [x] A trending-list token no longer creates a Meta; it appears only as leader inside its subject.
- [x] Theme-token pricing no longer needs the $50k floors; `candidates()` takes the newest graduates.
- [x] A thin window still qualifies and carries the coverage flag.
- [x] Existing meta tests are adapted; type-check, `pnpm lint` and `pnpm check` are green.
- [ ] After merge, one live tick shows Christmas as a Meta (cos checks).

## Notes
- Pointers: `packages/core/src/meta/compute.ts`, `leaders.ts`, `config.ts`, `coverage.ts`, `store.ts`, `topdown.ts`, `group.ts`; `study/store.ts`.
- Bonk graduations have no receipt and are ignored; ticket 03 notes this in the docs.
- Spec: `.scratch/graduation-meta/spec.md`.

## Comments
- 2026-11-22 17:05 [d37fa1ed] Box 'live tick shows Christmas as a Meta' stays open until Christmas-fix ticket 6; blocked on Luis's OK in .scratch/ops/issues/01-christmas-fix-breakdown.md
