# 13: An off-subject large-cap token cannot lead a Meta (Fartcoin led "GTA 6")
**Model:** sonnet / high. Two small changes in `leaders.ts` (the name index and the carry of a previous leader) and one argument from `compute.ts`; the diagnosis is the hard part and is done here. Not opus: the fix is pure code on data already in the tick.

**What to build:** the "GTA 6" Meta was led by Fartcoin ($87.09M, meta run 446, 2026-11-19T06:10Z), a token with nothing to do with GTA, and had been since run 330 (2026-11-18T01:24Z). No token that the subject's names do not carry, and that the AI grouping step left out of it, may lead that subject, and a wrong leader must not hold a Meta by having led it last run.

Status: done

**Blocked by:** none. Runs beside ticket 14 (unpriced DexScreener pairs); this ticket does not touch `topdown.ts` or `dexscreener.ts`.

## Problem and evidence (read-only from `.data/argus.db`)

- Run 446 `meta_current`: rank 1 `gtavi` / "GTA 6", leader `9BB6NFEc...pump` "Fartcoin", $87,091,643, `leader_source = trending`, `named_by = ai`, `entered_at = 2026-11-17T12:47:34.915Z`. The Meta itself is right (24 h: 1,060 tokens, 641 creators; themes `gtavi`, `vice`, `gta 6 strip club`, `mabel`, `jason`). Only its leader is wrong.
- The leader changed in one run. Run 329 (2026-11-18T01:09Z): `gta6` / leader "GTA VI" `4kjruq...`, $15.55M. Run 330 (01:24Z): `gta6` / leader Fartcoin, $90.14M. It stayed Fartcoin in every run after (e.g. 336, 379, 411, 440, 446): the `meta_current` rows with `leader_mint = 9BB6...` run from 330 to 446.
- It was not the grouping step. Fartcoin is a long-lived trending token (`meta_candidates` from run 232, GeckoTerminal, $92M, verified). The stored grouping answers for runs 330, 440 and 446 (`meta_groupings` 90, 188, 194) put Fartcoin in no subject: its id is in no `items` list and has no entry in `refs`; the GTA 6 subject there is `T13 T19 H1 H6` (GTA VI and one more trending token, the gta6 and vice themes). Earlier answers (groupings 7, 13, 62) made it a subject of its own, "Fartcoin".
- It was not a mint mix-up or a market-cap pick across the subject (the lookup budget and `verifyAgainstDex` are right: Fartcoin is a real $90M token, `verified = 1`). `leader_source = trending`: Fartcoin came in through the top-down candidates, then was attached to a subject.
- What changed at run 330: two tokens created at 2026-11-18T01:19:26Z and 01:19:45Z, name `dacity coin`, **ticker `fartcoin`** (two different creators, spam that copies a big token's ticker), sit in `study_tokens`. Replaying `groupTokens` on the 24 h window to run 330 puts both inside the 559-token `gta6` group (the Dacity spam name is the known hub of the union-find, `group.ts` `DEFAULT_MAX_PARTNERS`; nothing wrong with the cluster itself, the GTA names are 68 x `GTA 6/GTA COIN`, 58 x `GTA6/GTA6`, ...).

## Cause

1. **The leader name index trusts every token of a subject (`packages/core/src/meta/leaders.ts` `formIndex`, lines 98-110 on the parent).** For every subject it adds the name forms of *every* token in it (`for (const t of s.tokens) for (const f of tokenForms(t, minChars)) add(f, i)`). Two spam creates with the ticker `fartcoin` among 559 therefore made `fartcoin` one of the names of the GTA 6 subject. `match()` (line 177) then attached the real Fartcoin ($90M) to GTA 6 (it names no other subject), and `offer()` made it the leader because the leader is the highest cap (`betterLeader`) and $90M beats the GTA VI token's $15.5M. `theme.ts` already knows better for the same question: an anchor's subject forms are only the whole names that at least `keyShare` (10 %) of its tokens carry (`subjectForms`).
2. **A previous leader keeps its subject by having led it (`leaders.ts` `ownByMint`, line 209 and 221 on the parent).** `continues` maps the previous Meta to its subject by key, and `ownByMint` then offers the previous leader to that subject with no name check, so once Fartcoin led GTA 6 it stayed, run after run, even after the two spam tokens left the 24 h window (01:20Z on 11-19) and nothing named it any more. The carry is meant to keep a Meta alive when its leader's name is not in this tick's groups (the Trump and Space Squirrel Metas depend on it), so it cannot just be removed.

## Design

- **Name index by share.** In `formIndex`, a form of a subject's token names the subject only when at least `DEFAULT_THEME_CONFIG.keyShare` (10 %, `Math.ceil(tokens * 0.1)` tokens) of the subject's tokens carry it. The subject's own key still names it. For the 559-token GTA 6 cluster the bar is 56 tokens: `gta6`, `gtavi`, `gtacoin` pass, `fartcoin` (2 tokens) does not. A subject of up to 10 tokens still takes any of its tokens' names (every existing small-subject case is unchanged).
- **The carry yields to the AI step.** `currentMetas` takes an optional `grouped`: the mints of the trending tokens the AI grouping step was shown this tick (set by `compute.ts` only when the AI answer was applied, called or reused). A previous leader that is in `grouped`, that no subject holds by membership (`heldBy` runs first) and whose name no longer matches its subject, is not carried to that subject by `ownByMint`; it goes through `match()` like any token. On a tick with no AI answer nothing changes (the carry stands, so a failed grouping call never drops a Meta). The leader of the subject is then its best attached token, here the GTA VI token through its `groupKey`, and the Meta keeps its entry time.
- **Guard, in one sentence:** a trending token leads a subject only by (1) the AI step's membership, (2) a name that at least a tenth of the subject's tokens carry or the subject's own key, (3) being the subject's own theme token (`groupKey`), or (4) the carry of a previous leader the AI step has not just left out of it.
- No schema change, no new env knob, no stored-data change.

## Acceptance criteria

- [x] A test with a real-shaped fixture of run 330 (a 559-token `gta6` subject with the real name mix and two `dacity coin` / `fartcoin` creates; Fartcoin at $90.2M, trending, no `groupKey`; GTA VI at $15.55M with `groupKey: "gta6"`) gives one Meta `gta6` led by the GTA VI token. It fails on the parent commit (Fartcoin leads).
- [x] The same subject with Fartcoin as the only priced token gives no Meta and no Watching (fails on the parent).
- [x] The live state, a Meta whose previous leader is Fartcoin, with `grouped` holding Fartcoin and no name evidence, goes back to GTA VI and keeps its `enteredAt` of 2026-11-17T12:47:34.915Z (fails on the parent).
- [x] A token named by a tenth of the subject's tokens still leads it by name and keeps leading on the next run; a previous leader on a tick with no AI answer (`grouped` absent) is carried as before, and one the AI step holds by membership still leads (a Meta is not lost to a failed grouping call or to a rules tick).
- [x] `compute.ts` passes `grouped` only when the AI answer was applied; the existing meta tests (367 in `packages/core/src/meta`) pass unchanged.
- [x] Replay on the live DB copy (read-only): the parent's `currentMetas` on the rules-grouped tokens of runs 330, 345, 380, 412 and 440 reproduces the stored Fartcoin leader; the fixed code does not.
- [x] `pnpm check` passes once before the commit.

## Open / after deploy

- The running worker holds the old code: a worker restart (the Operator's call, `pnpm dev:start`) is needed. No data reset is needed: on the first tick with an AI answer (a call or a reuse, at most a tick or two; run 440 and 446 were both AI ticks) the Meta moves to the GTA VI token, keeps its entry time, and the stored rows of runs 330-446 stay as history.
- Not changed, noted: the Dacity spam name still lands inside the GTA 6 cluster (`group.ts`, the union-find hub); it now only adds tokens, not names. The carry for a subject nobody checks against (the Space Squirrel Meta, 0 copies, led by "Peanut the Squirrel") is unchanged.

## Constraints

- Do not touch `topdown.ts` or `dexscreener.ts` (ticket 14). Follow `docs/agents/worker-rules.md` and `CODING_STANDARDS.md`.
