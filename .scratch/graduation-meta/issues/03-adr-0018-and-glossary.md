# 03: ADR 0018 and glossary, so the docs say a Meta is graduations
**Model:** sonnet / medium — documentation with a grep-checkable result.

**What to build:** Write `docs/adr/0018-a-meta-is-several-tokens-graduating-on-one-narrative.md`. It supersedes the decision parts of ADR 0014 (leader cap $1M enter / $500k stay, Watching by cap) and the copies-rule paragraphs of ADR 0015, and keeps 0015's AI grouping and its fake-token filter for the trending list only. Mark both old ADRs "Superseded in part by 0018". In `GLOSSARY.md` rewrite **Meta** and **Watching**, add **Graduation** (a pump.fun migrate receipt, counted by graduation time; bonk graduations are ignored), and add "Avoid: Meta = leader at $1M". Update `docs/architecture.md` and `.env.example` for the six `ARGUS_META_*` keys (`metaMinGrads=10`, `metaStayGrads=5`, `metaMinCreators=6`, `metaLiveGrads6h=3`, `watchMinGrads=5`, `watchGrads6h=3`). Quote the Operator's definition from the spec in the ADR.

**Blocked by:** none (can run with 01)

**Status:** open

- [ ] ADR 0018 exists, quotes the Operator's definition and records the rule, stay, Watching and display-only cap.
- [ ] ADR 0014 and ADR 0015 are marked "Superseded in part by 0018", with what stays valid named.
- [ ] GLOSSARY has the new Meta and Watching, a Graduation entry and the "Avoid" line.
- [ ] `docs/architecture.md` and `.env.example` list the new keys with defaults.
- [ ] A grep finds no remaining `$1,000,000` Meta definition in docs; market cap appears only as display.
- [ ] `pnpm lint` and `pnpm check` are green.

## Notes
- Do not change code; ticket 01 owns the rule.
- Spec: `.scratch/graduation-meta/spec.md`.
