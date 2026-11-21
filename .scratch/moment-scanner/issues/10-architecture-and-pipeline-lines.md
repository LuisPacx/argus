# 10: Architecture doc and pipeline graph lines for the scanner
**Model:** haiku / low. Mechanical: add lines to two places so the docs match what tickets 01 to 06 built. No design.

**What to build:** `docs/architecture.md` and `packages/core/src/pipeline-graph.ts` describe the moment scanner the way they describe the other worker jobs: where it runs, what it reads and writes, its caps and its switches. Read the merged code of tickets 01 to 06 and write what is true, not what the spec planned.

**Status:** superseded

**Blocked by:** 06
Tickets 05 and 08 may or may not be merged by then; describe only what exists.

## Acceptance criteria

- [ ] `docs/architecture.md`: the line "No X as a Source ..." (section on Sources, near line 296) keeps its meaning and gains one sentence that the scanner (ADR 0009's 2026-11-19 amendment) searches X read-only, produces Moments and no Signals, and is off unless `ARGUS_MOMENTS=1`; the cap list (next to the Study caps, near line 325) gains the scanner's load caps (per scan, hour and day, the ramp), the judge cap (24 a day) and the angle allowance's use by "Make ideas"; the meme paragraph names the Moment as a fourth source; the "invariant 3" list names the new caps in code. Every number is read from `moments/config.ts` or the Brain routing, not from the spec.
- [ ] `packages/core/src/pipeline-graph.ts` lists the scan job, the judge task (with its model and cap) and the trace, in the style of the existing entries, with `ref` values that read the real constants; `pnpm test` for `pipeline-docs.test.ts` and `pipeline-graph.test.ts` passes.
- [ ] The architecture doc and the code agree: a grep for each number named in the doc finds the constant it came from; list the greps in Comments.
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- Docs and the graph only; no behaviour change. If a doc line and the code disagree, the code wins and the doc is fixed; report any disagreement that looks like a code bug in Comments.
- Commit subject `Moment scanner ticket 10: architecture and pipeline lines`, body ends with `Ticket: .scratch/moment-scanner/issues/10-architecture-and-pipeline-lines.md`.

## Comments
- 2026-11-21 cos triage: ADR 0009, the Operator researches; the automatic moment loop stays off (ARGUS_MOMENTS)
