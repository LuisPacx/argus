# 16: the copy check counts live tokens only, a contract error gets one repair retry, refusals do not spend the angle allowance
**Model:** sonnet / high. Touches the check, the retry loop, the run counting, a stored note and its card; the rules were decided by the Operator, so not opus.

**What to build:** the Operator-angle meme path (and the automatic meme-ideas path with it) filed 0 Proposals for 4 angles on 2026-11-19. Three things refused or wasted them. Fix all three.

Status: done

**Blocked by:** none (follows tickets 11, 12 and 15).

## Problem and evidence

Evidence: `.scratch/research/war-room-angle-howto.md` (untracked in the main checkout), "Failure modes seen (2026-11-19)".

1. Dexter's apartment was refused twice with "a name or ticker copies a token DexScreener lists". The names the model picked (Dexter, Slice of Life) are used by small coins with about $2 to 3K, which are not a live market. `dexCopies` in `packages/core/src/meme/pass.ts` treats every Solana pair DexScreener returns as a copy, however dead or drained.
2. Lucia muscle mommy was refused with "`ideas[0].ticker` is over 10 characters" on a single run. A contract error ended the request at once; only a copy got a retry.
3. The allowance was spent by refusals: 5 angle runs a day counted every run started, and the POST counted every request "whatever became of them". Four runs were burnt by three refusals, so only 3 requests got a real attempt, and the fifth ended `capped`.

## Design (Operator decisions, 2026-11-19)

1. **Copy check.** An idea is refused for a copy only when its name or ticker copies, by the existing normalisation (`checkDistinctName`), a token in the Meta block or the names to avoid (unchanged), OR a **live** DexScreener token. Live is the scans' real-clone test: priced (not `unpriced`), liquidity at least $5,000, market cap (FDV when there is no cap) at most 100 times liquidity; a token with several pairs is live when any pair is. A match on a dead or drained token does not refuse: the idea is stored with a short note, shown on the Proposal card in the War Room, `name also used by a dead token: <name> $<cap>` (or `ticker also used ...`; up to two tokens). The existing retry-once-on-copy stays for real copies. The `meme-ideas` SKILL.md copy rule is reworded to match.
2. **Contract errors** (ticker over 10 characters, wrong key set, a bad risk label list, not JSON, any refusal of `parseMemeOutput` that is not a copy): one repair retry whose prompt states the exact error (one line, code-written, cut), before the request is refused. A copy retry and a repair retry are independent, one each, so a request makes at most 3 runs.
3. **Allowance.** An angle run counts against the angle allowance (`DEFAULT_ANGLE_DAILY_MEME_RUNS`) only when its request files Proposals (one per filed trio; a trio whose retry filed it counts once). A separate hard cap on all angle attempts (refused runs and retries included) is `ANGLE_ATTEMPT_CAP_FACTOR = 3` times the allowance, so 30 runs a day by default, and the capped message says so. The default allowance rises from 5 to 10 a day, for both the angle runs and the POST's request limit (`DEFAULT_MEME_ANGLE_PER_DAY`); the ceiling stays 10. The POST's request limit counts only requests that are waiting, running or done, plus the same 3x cap on every request. The regular 8 a day cap is unchanged. The pipeline-graph lines show the new numbers and the factor.

## Acceptance criteria

- [x] Live test (`live-token.test.ts`): $5,000 liquidity with a $500,000 cap is live; $4,999 is not; a $500,001 cap on $5,000 is not; FDV stands in for a missing cap; neither cap nor FDV is not live; an `unpriced` pair is not live.
- [x] Fixtures for each failure (`pass.test.ts`): Dexter, with DexScreener answering a $2.4K-liquidity token of the same name, is stored with the dead-token note and costs one run; the same name on a live token ($30K liquidity, $200K cap) is retried once and refused when it copies again (the existing behaviour). Muscle Mommy, with the ticker `MUSCLEMOMMY`, gets one repair retry whose prompt carries the exact error and is stored when the retry fits; refused with the problem when it does not (two runs, never three for the same kind). Four refused angle requests do not stop a fifth: it runs, and the allowance counts only the filed ones.
- [x] The note is stored with the Proposal (additive column, old DBs open), comes back on `Proposal.meme.copyNote`, and the War Room card shows it as text (`meme-render.test.ts`; a hostile token name is escaped and cut).
- [x] Allowance (`pass.test.ts`, `angle.test.ts`): 10 filed angle trios in 24 h end the next request `capped` with the allowance message and no Brain call; refused runs do not count toward it; 30 attempts end it `capped` with the hard-cap message saying "3 times the allowance"; the POST refuses at 10 counted requests and at 30 of all requests, and a refused request does not count toward the 10.
- [x] `pipeline-graph.ts` and its test show the new defaults and the factor; `ARGUS_MEME_ANGLE_MAX_PER_DAY` accepts 1 to 10 and still only lowers the default.
- [x] SKILL.md copy rule says live tokens refuse, dead ones are noted; the output contract mentions the repair retry and short tickers.
- [x] `docs/architecture.md` and ADR 0013's angle lines show the new numbers; type-check and the full `pnpm check` pass, run once before the commit.

## Constraints

- No RegExp built from token names, notes or errors. Token names in the note are creator text: cleaned and cut by `cleanLine`, rendered as text.
- Do not call `/api/meme-angle` on the live War Room; do not restart the live apps.
- Follow `docs/agents/worker-rules.md` and `CODING_STANDARDS.md`.

## Comments

- Moment scanner ticket 04 has its own real-clone classifier planned with the same two numbers ($5,000, 100x) in `moments/config.ts`. This ticket's `live-token.ts` is the first code with the rule; when ticket 04 lands it should reuse it or the two must be kept equal.
