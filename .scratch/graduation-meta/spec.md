# Graduation Meta: a Meta is several tokens graduating on one narrative

Status: approved by the Operator, 2026-11-22 ("yes as you recommend, include ticket 4"). Tickets: `issues/01` to `issues/04`.

## 1. Problem

Today a Meta is led by one token: its market cap must pass $1M (enter) and stay above $500k (ADRs 0014, 0015). That misses the real signal. The Christmas wave in November 2026 had about ten tokens graduating on one narrative (Bullmas, Santa Inu, CATEMAS, snowball, pepesanta and more) and no Meta, because no single token was big or priced enough. The Operator's definition:

> "it isn't about a coin going to 1m+, it's about the amount of tokens graduated on a same narrative. that's how a meta is meta, several tokens graduating on the same narrative."

## 2. Design

- **Graduation** is a pump.fun migrate receipt (`study_tokens.migrated_at`). It is counted by graduation time, not create time, so a late graduate of an older create counts. Bonk graduations carry no receipt, are ignored, and are noted in the docs.
- **Subject** is the AI subject (the merged launch themes from `meta_groupings`). A graduate is matched to a subject by name/ticker key forms the way `compute.ts` groups (`tokenSubjectForms`, group keys). An ambiguous match joins no subject.
- **Meta**: at least 10 graduations in 24 h, at least 6 distinct creators, at least 3 in the last 6 h. **Stay**: at least 5 in 24 h; the state is carried for `stateMaxMinutes` (default 120). At most 3 Metas, ranked by 24 h graduations, then 6 h, then creators.
- **Watching**: not a Meta, with at least 5 in 24 h or at least 3 in 6 h; top 3 by 6 h, then 24 h.
- **No share-of-all condition.** The share ("10% of all graduations") is display only.
- **Leader and market cap** are display and tie-break only. The leader is the highest-priced graduate, else the latest graduate with the cap shown as a dash. Downstream types are unchanged. The enter/stay market-cap thresholds leave the rule.
- **Trending lists** (top-down) no longer create Metas. A big token appears only as leader inside its subject. Fake-token screening stays for the trending list only.
- **Price fix (display)**: theme-token pricing skips the $50k liquidity/volume floors (the cap/liquidity ratio check applies only when liquidity is above 0). `candidates()` asks for the newest graduated tokens, not the oldest 30.
- **Thin data**: stream gaps and `study_gaps` still let a subject qualify but flag it ("10 graduated in 24h (covered 5 of 24 h)"), using the existing `metaCoverage()` / coverage note intersected with `study_gaps`.
- **Config**: new `ARGUS_META_*` keys read with `intIn()` in `packages/core/src/meta/config.ts`: `metaMinGrads=10`, `metaStayGrads=5`, `metaMinCreators=6`, `metaLiveGrads6h=3`, `watchMinGrads=5`, `watchGrads6h=3`.
- **Store**: a new read-only `StudyStore.graduatedBetween(fromIso, toIso)` on the `migrated_at` index. Per-subject grads `{24h, 6h, creators24h, share}` live in the existing counts JSON (no schema change).

## 3. Reference fixture (Christmas)

Themes: santa, snowball, xmas, grinch, goonmas, christmas, bullmas, holdmas, pepemas, catemas, fomomas. Graduates: Bullmas, snowball, ChristmASS, Santa Inu, Snowball, CATEMAS, snowball-v2, Saint Nicholas SANTA, pepesanta, Christmas Inu; 10 creators; 3 in the last 6 h. Expected: one Meta "Christmas", 10 in 24 h, 3 in 6 h, 10 creators.

## 4. Rules kept

- Plain code decides Metas (ADR 0012); the model only names and summarises.
- Nothing launches or signs (ADR 0002).
- No new schedule and no schema change.

## 5. Out of scope

Bonk graduations (no receipt). Any share-of-all threshold. Changing downstream Meta types.

## 6. Tickets

1. `01` rule, compute, leaders, config and price fix.
2. `02` War Room Meta strip and page (blocked by 01).
3. `03` ADR 0018, GLOSSARY, architecture and `.env.example` (can run with 01).
4. `04` gap warning and since-the-last-gap counter (blocked by 02).
