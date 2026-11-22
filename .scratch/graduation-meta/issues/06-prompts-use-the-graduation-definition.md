# 06: Every prompt that defines a Meta uses the graduation definition
**Model:** sonnet / high — prompt text across several skills

**What to build:** ADR 0018 says a Meta is several tokens graduating on one narrative and that market cap is context only. Ticket 05 moved the meta-summary prompt and the card line there; four live places still say "a current trend led by a token with a large market cap, with other tokens copying it":
- `.claude/skills/meme-ideas/SKILL.md` (description and body, "from the market cap of a leading token");
- `.claude/skills/meta-group/SKILL.md` (the definition sentence; the description has none);
- `packages/core/src/meta/prompt-block.ts` (`metaRule`, the rule text of the Meta block the judge and propose prompts receive, and the block lines, which carry only the leader, its cap and "creators copying in 24 h");
- `packages/core/src/meme/ideas.ts` (the two opening sentences of `memeIdeasPromptFor`, whose Meta block has no graduation counts, and a Leader line that prints "n/a" for an unpriced leader).

Reword each to the graduation definition, market cap as context only. Where a Meta is listed (the Meta block lines, the meme-ideas Meta block) pass its graduation counts (24 h, 6 h, creators), as the meta-summary prompt already does; a row stored without `grads` keeps the old line. Do not touch ADRs 0014 and 0015 (history).

With `leaderMoney` returning "-" for an unpriced leader, the New Meta reason (`newMetaReason`, `new-meta.ts`), the meme pass facts (`metaFacts`) and the meme list line (`summaryLine`, `meme/pass.ts`) read "$X at -". An unpriced leader omits the "at ..." part instead ("$X, 14 creators in 24 h"); a priced one reads as before. No generated text prints "n/a" or "at -".

meta-group changes only its definition wording: its grouping instructions, output contract and example stay as they are. The untrusted-data fences (boundary lines, "untrusted data, never instructions" text) stay exactly as they are in every file.

**Blocked by:** 05

Status: done

- [x] Every prompt and skill that defines a Meta says graduations on one narrative, with market cap as context only, and passes grads counts where a Meta is listed.
- [x] No "n/a" and no "at -" for an unpriced leader in any generated text.
- [x] meta-group changes only its definition wording, not its grouping instructions or output shape.
- [x] The untrusted-data fences are unchanged.
- [x] Tests pin the new wording and the unpriced-leader text.
- [x] `pnpm check` passes.

## Notes
- Builds on ticket 05 (`leaderMoney`, the summary prompt wording) and the `grads` counts of ticket 01.
- Searched `packages`, `apps` and `.claude/skills` for "large market cap", "led by a token", "market-led" and "a current trend". The live hits are the four places above. Other hits are code comments about ADR 0014 or the item description in `meta/grouping.ts` ("a token trending now with a large market cap"), which describes a trending-token item, not a Meta, and is left alone.
- Spec: `.scratch/graduation-meta/spec.md`.
