# 01: Local bonded set, match and merge, so a brief can find themed coins the literal search misses
**Model:** sonnet / high — pure matching and ranking logic with careful edge cases, wired into an existing researcher with tests.

**What to build:** A Research brief takes its coins from one search for the literal topic. Add a second source that needs no network: the tokens Argus itself saw migrate in the last 7 days (read-only, from the Study store). Match them against a list of terms in plain code, case-insensitive over name, ticker and description; a term shorter than 4 characters matches only at the start or end of a word, so "mas" finds "CATEMAS" but not "Thomas". Merge the two sources: literal-search hits are kept as today; an extra candidate (from the local set or a term) is kept only if it is bonded (a local migration wins, else a graduation venue with at least $5K liquidity). Order bonded first, then market cap, then liquidity, and raise the candidate cap from 15 to 25. Each candidate carries a code-set `via` (the term that matched it). The model sees `bonded` and `via` in its candidate list but still only the ids c1..cN; names stay in the fenced untrusted block, and its limits (10 coins, 2 picks) do not change. In this ticket the term list is just the topic itself; no model call is added.

**Blocked by:** none

Status: done

- [x] A read-only query returns tokens migrated in the last 7 days (with a limit) and writes nothing.
- [x] With a fake store holding CATEMAS, BOSSMAS and Santa Inu as migrated and terms "xmas", "santa", "mas", all three become candidates, each with the term it matched as `via`.
- [x] An extra candidate that is not bonded is excluded; a literal-search hit that is not bonded is still kept.
- [x] "mas" does not match "Thomas"; matching is case-insensitive and covers name, ticker and description.
- [x] Candidates are ordered bonded, then market cap, then liquidity, and capped at 25.
- [x] The prompt candidates gain `bonded` and `via`; the model still sees only ids, and its coin and pick limits are unchanged.
- [x] Existing researcher tests pass unchanged.
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Notes
- Pointers: `pickCandidates` and `RESEARCH_CANDIDATES_MAX` in `packages/core/src/research/researcher.ts`; `decideBonded` in `research/picks.ts`; `migrationOf` in `datastore.ts`; `PromptCandidate` in `research/brief.ts`; `study_tokens` in `study/store.ts` (`recentMigrated` there is the wrong shape: cap 100, de-duplicated, so add a new query).
- The local set has gaps (`study_gaps`), so a mint can be missing; that is accepted.
- Spec: `.scratch/research-widen/spec.md`.
- 2026-11-22 cos: merged 16ab39d+95b4e39. Reviewer (sonnet high) SHIP; verifier PASS 06e83c1 (245/3978, page:check 0) and follow-up 86c5de3 (549 pass; 5 new tests fail on 06e83c1). Literal slots reserved (5), short stems name/ticker only, bonded unknown.
