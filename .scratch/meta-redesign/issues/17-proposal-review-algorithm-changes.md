# 17: work live Metas only, name inside the Meta, prefer the thing itself over fan-behaviour jokes
**Model:** sonnet / medium. Three Operator-approved changes from the proposal review; small edits to one pass function, one prompt, one skill and one validator.

**What to build:** apply proposed changes 1, 2, 3 and 5 of `.scratch/research/proposal-review/2026-11-19.md` (untracked in the main checkout), as the Operator approved them on 2026-11-19. Measurement (change 4) and pausing Tech Proposals (change 6) are not part of this ticket.

Status: done

**Blocked by:** none (follows tickets 15 and 16).

## Evidence (from the review)

- 18 Proposals went to Metas with 0 creates in the previous 6 h while the 8-a-day cap refused GTA VI (605 copiers), DacityCoin (230), Anthropic (107) and GTA Mabel (52); 17 `daily-cap` refusals in 4 days. A run costs about $0.04 (8 cost $0.31 to $0.35).
- Names with the Meta's word bond 1.53% organic against 1.11% without; the bare GTA title or character 2.95%; only 6 of 72 meme names carried the Meta's word. The prompt pushed names to differ from the leader.
- 15 of 15 automatic GTA ideas were fan-behaviour side jokes; the market launched them 81 times and none bonded.
- Names of 4+ words bond at 0.64% organic against about 1.26% for 1 to 3 words.

## Acceptance criteria

- [x] `dueMetas` skips a **refresh** (a never-tried Meta, a refresh slot, a failed refresh retry) when the Meta had fewer than `MEME_LIVE_MIN_CREATES` (10) creates in its `6h` counts window (`MEME_LIVE_WINDOW`), both constants in `meme/pass.ts`. A New Meta event is never skipped by this rule. A skipped Meta starts no run, records nothing and is due again when its flow is back. Test: 9 creates skipped, 10 due, a New Meta with 0 creates still due, a failed refresh retry skipped.
- [x] `DEFAULT_MEME_CONFIG.maxRunsPerDay` is 24 (was 8); `ARGUS_MEME_MAX_PER_DAY` still accepts 1 to 40; the hard ceiling stays 40. Pipeline-graph line, architecture notes, startup-config and War Room tests show 24. The 3x attempt cap is the angle cap (`angleAttemptCap(angle allowance)` = 3 x 10 = 30) and does not depend on `maxRunsPerDay`, so it stays 30; the regular cap has no multiple.
- [x] `meme-ideas` prompt and SKILL.md: at least one idea per trio uses the Meta's own word or the in-game or proper name, in 1 to 3 words; a parody name using the subject's word is allowed as long as it does not claim to be official; the instruction to differ from the leader's name is dropped (the live-token copy check and the names-to-avoid rule stay). `difference` is no longer framed as "how it differs from the leading tokens".
- [x] Same files: angles prefer the thing itself (a character, place, object or event from the source) in plain words; at most one fan-behaviour side joke per trio (sick day, delay, pre-order, loading screen and the like); no longer "three different angles" defaulting to side jokes.
- [x] `parseMemeOutput` refuses a name of 4 or more words (split on whitespace), with a fixed repair sentence, so the existing one repair retry applies. Test for 3 words ok, 4 words refused and retried once.
- [x] ADR 0013 amended briefly with the reasons and the review's numbers; `pnpm check` passes, run once on the committed tree.

## Constraints

- No RegExp from non-literals. Follow `docs/agents/worker-rules.md`.
- Do not restart the live apps.
