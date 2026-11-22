# 05: The Meta summary line is graduation-led
**Model:** sonnet / high — prompt and templated copy

**What to build:** ADR 0018 says a Meta is several tokens graduating on one narrative and that market cap is context only, but the summary line under each War Room Meta card is still market-led. The templated numbers line (`currentTemplateLine`, `packages/core/src/meta/summary.ts`) reads "led by SEED Chair coin at $2.4M; 28 tokens from 14 creators in 24 h, 7 migrated (unfiltered)", and an unpriced leader reads "at n/a". The meta-summary prompt (`metaSummaryPromptFor`) and `.claude/skills/meta-summary/SKILL.md` still define a Meta as "a current trend led by a token with a large market cap". The card already shows the graduation line from ticket 02 (`CurrentMeta.vue`), so it states the Meta twice in conflicting terms.

Make the line graduation-led. With `grads` present the numbers line leads with the graduations (24 h, 6 h, creators) and mentions the leader and its cap only as context; a row stored without `grads` keeps the old form. An unpriced leader is a dash, never "n/a" or "$0". The card shows one statement of the Meta, not two: the templated line is not drawn under a graduation line that says the same. The prompt and the skill describe a Meta by its graduations, market cap as context only, and the prompt carries the grads counts (they stay out of the model's line: the no-figures rule holds).

**Blocked by:** 01, 02

Status: done

- [x] The templated numbers line leads with graduations (24h, 6h, creators) when `grads` is present, and falls back to the old form only for old rows without `grads`.
- [x] An unpriced leader shows a dash (-), never "n/a" or "$0".
- [x] The line does not duplicate the ticket-02 graduation line on the card (merged into one line, or the redundant one dropped, whichever keeps the card clean).
- [x] The meta-summary prompt and `SKILL.md` describe a Meta by graduations, with market cap as context only, and the prompt passes the grads counts.
- [x] Tests cover the new line, the dash and the prompt content.
- [x] `pnpm check` and `pnpm page:check --seed /meta /` pass.

## Notes
- Builds on the `grads` counts of ticket 01 and the card of ticket 02. Ticket 04 (gap warning) edits `CurrentMeta.vue` at the same time: keep this ticket's template change minimal and leave the `current-grads-coverage` line alone.
- A stored model line is prose and stays on the card; only the templated stand-in is affected.
- Spec: `.scratch/graduation-meta/spec.md`.
