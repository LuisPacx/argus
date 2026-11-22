# A Meta is several tokens graduating on one narrative

Status: accepted (decided by the Operator, 2026-11-22: "yes as you recommend, include ticket 4"; `.scratch/graduation-meta/spec.md`, ticket 03). Supersedes the decision parts of ADR 0014 (the leader market-cap thresholds and Watching by cap) and the copies-rule paragraphs of ADR 0015. Both are marked "Superseded in part by 0018".

ADR 0014 made a Meta a trend led by one token above $1,000,000 (stay at $500,000), with at least 10 creators copying it. That misses the real signal. The Christmas wave of November 2026 had about ten tokens graduating on one narrative (Bullmas, Santa Inu, CATEMAS, snowball, pepesanta and more) and no Meta, because no single token was big or priced enough. The Operator's definition:

> "it isn't about a coin going to 1m+, it's about the amount of tokens graduated on a same narrative. that's how a meta is meta, several tokens graduating on the same narrative."

## Decision

1. **Graduation.** A graduation is a pump.fun migrate receipt (`study_tokens.migrated_at`), counted by graduation time, not create time, so a late graduate of an older create counts. Bonk graduations carry no receipt and are ignored.
2. **Subject.** The subject is the AI subject (the merged launch themes of `meta_groupings`, ADR 0015). A graduate joins a subject by the name and ticker key forms `compute.ts` groups by; an ambiguous match joins no subject.
3. **Becoming a Meta.** At least 10 graduations in 24 h, from at least 6 distinct creators, with at least 3 in the last 6 h (`ARGUS_META_MIN_GRADS`, `ARGUS_META_GRAD_CREATORS`, `ARGUS_META_LIVE_GRADS_6H`).
4. **Staying.** A Meta stays while it has at least 5 graduations in 24 h (`ARGUS_META_STAY_GRADS`). State is carried for `ARGUS_META_STATE_MAX_MINUTES` (default 120), as before. At most 3 Metas, ranked by 24 h graduations, then 6 h, then creators.
5. **Watching.** A subject that is not a Meta with at least 5 graduations in 24 h or at least 3 in 6 h (`ARGUS_META_WATCH_MIN_GRADS`, `ARGUS_META_WATCH_GRADS_6H`); the top 3 by 6 h, then 24 h.
6. **Market cap is display only.** There is no market-cap threshold to enter, stay or be Watching. The leader (the highest-priced graduate, else the latest graduate with the cap shown as a dash) and its cap are shown and break ties. The share of all graduations is display only; no share condition exists. Downstream Meta types are unchanged.
7. **Trending lists no longer create Metas.** A big token appears only as the leader inside its subject. Jupiter and GeckoTerminal trending, the fake-token filter and DexScreener verification stay, for the trending list only.
8. **Thin data is flagged, not hidden.** Stream gaps and `study_gaps` still let a subject qualify, with a note such as "10 graduated in 24h (covered 5 of 24 h)".
9. **Reference fixture:** the Christmas wave (10 graduates, 10 creators, 3 in 6 h) is one Meta "Christmas".

Plain code decides Metas (ADR 0012); the model only names and summarises. Nothing launches or signs (ADR 0002). No new schedule and no schema change.

## What stays valid

- From ADR 0014: the at-most-3 cap, hysteresis, staleness and the state carry, `meta_current`, New Meta, summaries, the prompt block, the meme trigger, and the Brain having no part in deciding what is a Meta.
- From ADR 0015: the AI grouping step (`meta-group`) and its fallback to rules, the fake-token filter and DexScreener verification for the trending list, `meta_candidates`, and the Jupiter read-only path.

## Considered options

- **Keep the market-cap rule and lower the threshold.** Rejected: any threshold still misses a wave of many small tokens, which is the case the Operator described.
- **A share-of-all-graduations condition.** Rejected by the Operator; shown only.

## Consequences

- A subject with many small graduates is a Meta; one big token alone is not.
- Bonk waves are invisible until a receipt exists for them.
- Env names are read in `packages/core/src/meta/config.ts`.
