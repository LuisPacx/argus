# 21: Cut propose invalid-output (evidence count, tech length) with a prompt fix and one repair retry
**Model:** sonnet / medium — one prompt change, one retry step modelled on the existing name retry, one test file.

**What to build:** Make far fewer propose runs end `invalid-output`, without loosening the validator. Today a propose answer that misses the schema is refused and costs a run; the Narrative is then excluded from propose until it is scored again (datastore.ts 1060-1125).

**Status:** done (3869dfe on main)

**Needs a worker restart** (prompt and pass code are loaded at start). Do not merge under a live run: merge between runs, then restart the worker.

## Findings (acceptance run, 2026-11-06T18:58Z to 2026-11-08T02:02Z, `brain_runs` task=propose)

66 propose runs: 48 success, 18 `invalid-output`. Last 24h: 33 runs, 10 invalid. Classified from `worker.log` (the only record; refused output is not stored and the log cuts it to 200 chars, so the evidence array itself is not recoverable):

| Failure | Whole run | Last 24h |
|---|---|---|
| `evidence` not 3 to 5 links (12 first runs, 4 name-retry runs) | 16 | 9 |
| `tech` over 200 characters (run 334, narrative 90) | 1 | 1 |
| Not a single JSON object (name-retry run 155, narrative 59, log line 4560) | 1 | 0 |
| Evidence has a bad or duplicate link, name/ticker/whyNow/description over limit | 0 | 0 |

Too few vs too many cannot be told from the log. Strong circumstantial evidence for too few: 14 of the 18 refused runs were on Narratives with 1 to 2 distinct Signal URLs (11 had exactly 1; the largest, 467, had 10). The skill says "preferably the Signals' own links", so a one-Signal Narrative gives the model one link and it stops there instead of searching.

## Where the limit lives

- Validator: `packages/core/src/propose.ts` `parseProposeOutput`, evidence count at line 69-70, tech limit via `PROPOSE_LIMITS` (line 21, `tech: 200`, `evidenceMin/Max: 3/5`). Over a limit the answer is refused, never cut (by design).
- Prompt: the inline contract in `proposePromptFor` (propose.ts line 102) and `.claude/skills/propose/SKILL.md` ("What to write > Evidence", "Output contract"). Both state 3 to 5 and 200; neither says what to do when the Signals carry fewer than 3 links, and neither asks the model to count before answering.
- Refusal and logging: propose.ts line 324-327. The name retry (`retryName`, line 235-270) already shows a second propose run under the same daily cap.

## Recommended approach

Do both of these, in this order of value:

1. **Prompt**: tell the model how many distinct Signal links the Narrative has (computed in `proposePromptFor`); when fewer than 3, say it must use WebSearch/WebFetch to find the rest; add a last-line check ("count your evidence links, 3 to 5; count `tech`, at most 200") in the prompt and SKILL.md.
2. **One repair retry**: when the first answer is `invalid-output` for a length or count problem, run propose once more with the original prompt plus the problem text ("your last answer was refused: `evidence` must be an array of 3 to 5 links; return the corrected object"), under the same daily run cap and budget as any run, modelled on `retryName`. The retry run gets its own `brain_runs` row; the Narrative is excluded only if the retry also fails.

Why this over the alternatives: prompt alone cannot fix the model returning 2 links for a 1-Signal Narrative reliably; a repair retry alone burns a second run every time the first prompt is unclear. Together they fix the cause and cap the loss. Truncating or padding in code is rejected: cutting `tech` changes meaning, and padding evidence invents links (the skill says never invent a link).

## Acceptance criteria

- [x] `proposePromptFor` states the Narrative's distinct Signal-link count and, when it is below 3, tells the model to find more links on the web; SKILL.md carries the same instruction and the count/length self-check. Test on the prompt text for a 1-Signal and a 10-Signal Narrative.
- [x] An `invalid-output` first answer for evidence count or `tech`/other length triggers exactly one repair run with the problem text in the prompt; a valid repair is stored as a normal Proposal, the first run stays `invalid-output`, the repair run is `success`. A second failure leaves two `invalid-output` rows and no further run. Bad JSON, a rate limit, interruption or budget error does not retry.
- [x] The repair run counts against the daily propose-run cap and budget exactly as the name retry does; a pass at the cap does not retry.
- [x] The refusal log line adds the evidence array length and `tech` length (numbers only, never the untrusted text) so the next analysis can separate too few from too many.
- [x] A test file with fixtures built from real failing outputs: the logged 200-char prefixes of runs 103, 130, 142, 306, 321, 334 (names, tickers and tech lines from `worker.log` lines 3309, 3826, 4183, 14485, 14866, 15243), completed with evidence arrays of 0, 1, 2 and 6 links and, for 334, the over-length `tech`, each asserting `parseProposeOutput` refuses with the exact problem. The prefix-and-completion origin is stated in the file's comment because the full outputs were never stored.
- [x] `PROPOSE_LIMITS` and the validator are unchanged.
- [x] `pnpm check` passes.

## Out of scope

- The judge cap (pending the Operator's quota review).
- The rule that one `invalid-output` excludes a Narrative until it is scored again (datastore.ts 1060-1125), pending the same review.
- Storing refused outputs in full.

## Comments
