# 15: the meme-ideas skill gets naming rules learned from the GTA VI coins
**Model:** sonnet / low. One skill file, no code.

**What to build:** the `meme-ideas` Brain skill (`.claude/skills/meme-ideas/SKILL.md`) says a name and ticker must be new, but not what makes a name work. A day of GTA VI coins (2026-11-18/19) showed winners used the exact words people typed about the clip's object ("Mobility Scooter", "Jet Ski Dog", "HULK"), or the game's own proper name (BOOMAZOOM), described what was shown instead of a pun or quoted line, and kept names short without suffixes. Add those four rules under "What to write". Evidence: `.scratch/research/gta6-naming-lessons.md`, "What wins" and "Rules for prompts" (untracked in the main checkout). The sample is thin: one day, 1 to 3 coins per pattern, most peaks launcher-driven, so these are tendencies, not laws. Left out on purpose: the file's rule 5 (searching the post's replies needs tools; the skill has none) and rule 6 (image style, too thin).

Status: done

**Blocked by:** none.

## Acceptance criteria

- [x] "What to write" has a "Naming" sub-list with four rules: plain words people use or the proper name (never an invented synonym, still new versus the Meta block); a plain description over a pun, joke phrase or quoted line; 1 to 3 words with no suffixes such as "Coin", "Inu", "Cult"; a proper name is the best ticker, within the ticker rule.
- [x] The copy rule, the ticker rule and the output contract are unchanged.
- [x] No test or code pins the skill text (checked with grep under `packages/` and `scripts/`); type-check and the full `pnpm check` pass, run once before the commit.

## Comments

- Revisit once more Metas have launched coins: with 1 to 3 coins per pattern, a rule that does not hold up should be dropped.
