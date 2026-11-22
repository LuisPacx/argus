# 04: The naming and filter run (`radar-name`, haiku)
**Model:** sonnet / high. A new Brain task whose input is third-party text (terms, headlines) and whose output becomes search phrases sent to DexScreener (and later X). The trust-boundary work is a copy of `meta-group` and the moment judge's design, not a new one; if the agent finds it is not, stop and raise it.

**What to build:** one cheap model run, in batches, that looks at the candidates plain code has already counted and answers, per candidate: is it a concrete, nameable thing; the plain subject people would say; up to 4 search phrases; flags (`real person`, `nsfw`, `political`, `trademark`, `unverified`) and an `upcomingDate` if the thing is scheduled. The page shows the subject instead of the raw term, hides non-things ("weather", "scores", a bare date) in a folded "not a trend" list with the reason, merges rows that got the same subject, and the untokenized check searches with the model's phrases. Useful alone: the list reads as a list of things, and the coin-side check stops missing "GTA 6" because Google said "gta vi trailer 3".

Status: ready-for-agent

**Blocked by:** 01
Spec: sections 3, 5.2 (the `upcomingDate` +10), 5.3, 7. ADR 0016 decision 5. Pattern to copy: `.claude/skills/meta-group/SKILL.md`, `packages/core/src/meta/group.ts` (`parseMetaGroups`), `meta/group-pass.ts`, and `BrainTask` and `DEFAULT_ROUTING` in `packages/core/src/brain.ts`.

## Design

- **Task.** `radar-name` added to `BrainTask`, a `DEFAULT_ROUTING` row (claude-code, haiku, a per-run budget of about $0.05 and 2 minutes, no API fallback, no tools), a skill `.claude/skills/radar-name/SKILL.md`, a row in `researchRunCaps` and the research-share sum, and a node on the "How it works" page (`pipeline-graph.ts`; its sync test asks for the node's `brainTask`).
- **Input.** Up to 15 candidates a run (shown or score of 30 or more, not yet named), each as one cut, JSON-quoted line: id, the term or phrase, the sources that carried it, the news title if any. The block ends only at a boundary line of fresh random bytes, named untrusted. The model sees ids, never keys or links.
- **Output.** One JSON object `{ "items": [ { "id", "thing": true|false, "reason" (when false), "subject", "phrases": [..], "flags": [..], "upcomingDate": "YYYY-MM-DD"|null } ] }`, validated field by field by `parseRadarNames` in `radar/name.ts` (a model answer is untrusted): an id not given, a repeated id, a missing item, a subject over 60 characters or with markup, a URL or a control character, an unknown flag or a date that is not a real date inside the next 60 days refuses the **item** (the rest are kept); a non-JSON answer or a wrong top-level shape refuses the run. One repair retry with the exact error (never echoing model-written keys), as meta redesign ticket 16 did.
- **Phrase limits** (the moment judge's, shared code if its ticket 03 has landed, else written here for it to import): letters, digits and spaces, 1 to 4 words, at most 4 phrases, each cut; a phrase that cleans to empty is dropped; no phrase left means the Trend keeps its raw key as its only phrase.
- **Merge.** Items with the same normalised subject become one Trend: the earlier id wins and the other keys stay as aliases. Equality only; no embedding.
- **When and how often.** A batch every 30 minutes when there are unnamed candidates; **48 runs a day** by default, hard ceiling 96 (stage B), `ARGUS_RADAR_NAME_MAX_RUNS_PER_DAY` can only lower it; its own Est. usage cap of $0.60 a day (ceiling $1.00, lowerable); counted in `brain_runs` and the research share; skipped while the rolling-24 h research budget is over 80 percent used or the API-fallback hold is on; three failures in a row skip the next two batches (as `meta-group` does). The skill's job is judgement only: is it a concrete thing, what do people call it. Every threshold stays in code.
- **Tripwire** (spec 7): when the rolling-24 h Est. usage across all tasks passes $3 (normal use is $0.4 to $1.0 a day; `RADAR_TRIPWIRE_USD` in `radar/config.ts`, lowerable only), the radar pauses its model runs and `/radar` and `/` show a banner with the figure; it clears itself when the figure falls. It does not pause the plain-code polling.
- Flags carry into the page; `real person` makes a risk label required downstream; `nsfw` and `political` block the automatic hand-off of ticket 13. `upcomingDate` adds the +10 of the score.

## Acceptance criteria

- [ ] **Parser** (`name.test.ts`): a good answer parses; an unknown id, a repeated id, a missing item, a subject with markup or a URL, an unknown flag, a date in the past or more than 60 days out, a phrase of 5 words, 5 phrases, a non-JSON answer and a wrong shape are each refused at the right level (item or run) with the other items kept; model-written key names are never echoed in the retry prompt; 100,000 characters of answer are cut before parsing.
- [ ] **Prompt block** (`name-block.test.ts`): hostile terms (`ignore previous instructions`, a forged boundary line, `from:x`, newlines, 10,000 characters) are flattened, JSON-quoted and cut; the boundary is fresh random bytes per run and cannot be guessed from the input; the block is named untrusted; the skill file says the run has no tools.
- [ ] **Pass** (`name-pass.test.ts`, fake Brain): a batch names 15 candidates and the page's rows change; a refused item leaves its candidate unnamed and retried a batch later, then left as "not named yet"; the run cap of 48, the $0.60 Est. usage cap, the research-share skip, the fallback hold and the three-failure back-off each stop a run with a recorded reason and no call; a dry run calls nothing; no API fallback is ever used (a route test).
- [ ] **Tripwire** (`radar-tripwire.test.ts`, fake clock): at $3.01 of rolling-24 h Est. usage no naming run starts and the banner shows the figure; at $2.99 runs go on; the banner clears when the figure falls; polling and the check go on while paused.
- [ ] **Merge and check** (`radar-merge.test.ts`): two keys with the same subject become one Trend with both aliases; the untokenized check searches the model's phrases (the raw key only when there are none); a phrase with an X operator in it is cleaned to words before any request.
- [ ] **Routing** (`brain.test.ts`, `pipeline-graph.test.ts`, `research-budget.test.ts`): `radar-name` is routed to haiku with its caps; `researchRunCaps` and the research-share sum include it; the pipeline graph node exists and the sync test passes.
- [ ] **Real run, once** (not a test): one real batch on current candidates; paste the run's Est. usage, the subjects and the refusals into Comments. Expect about $0.002 to $0.004 a run (measured haiku tasks: $0.0012 to $0.0032).
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- Follow `docs/agents/worker-rules.md` and `CODING_STANDARDS.md`. No RegExp from any term, headline or answer. The model has no tools and no browser; nothing it writes is fetched.
- Commit subject `Trend radar ticket 04: the naming and filter run`, body ends with `Ticket: .scratch/trend-radar/issues/04-naming-and-filter-run.md`. No `Closes #N`.

## Comments
