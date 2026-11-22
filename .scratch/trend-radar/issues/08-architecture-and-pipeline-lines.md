# 08: Architecture doc and pipeline graph lines for the radar
**Model:** haiku / low. Mechanical: add lines to two places so the docs match what tickets 01 to 07 built. No design.

**What to build:** `docs/architecture.md` and `packages/core/src/pipeline-graph.ts` describe the trend radar the way they describe the other worker jobs: where it runs, what it reads and writes, its caps and its switches. Read the merged code of tickets 01 to 07 and write what is true, not what the spec planned. Useful alone: the "How it works" page and the architecture doc match the code.

Status: ready-for-agent

**Blocked by:** 07
Tickets 05 and 06 may or may not be merged by then; describe only what exists. Pattern: moment scanner ticket 10.

## What to write

- `docs/architecture.md`: section 6 (Sources) gains a short "The trend radar" paragraph under the "No X as a Source" line: it reads Google Trends rising terms and the radar-only feed list into its own tables, makes no Signals, is not a `Source`, and uses no X page loads; section 5 (Brain) gains the `radar-name` task in the routing table and one paragraph (haiku, no tools, no API fallback, batch every 30 minutes, 48 runs a day, its own Est. usage cap, counted in the research share); section 10 (Invariants), item 1 and 3: the X API key (only if ticket 10 has merged) and its daily and 30-day dollar caps and request caps; and **item 5**, which lists the public-API reads that are allowed ("PumpPortal events, DexScreener"): add the radar's reads (Google Trends rising terms, the radar-only news feeds and, only if tickets 10 to 12 have merged, X's official API Trends and Counts), keeping its sentence that argus never deploys tokens and has no wallet. Name the real file paths, switches (`ARGUS_RADAR`, `ARGUS_RADAR_NAME_MAX_RUNS_PER_DAY`) and caps from the code.
- `packages/core/src/pipeline-graph.ts`: a radar node and its edges (readers, score, check, name run, page, hand-off), with `brainTask: "radar-name"` on the naming node and its caps as `live` knobs like the other nodes. The sync test (`pipeline-graph.test.ts`, `pipeline-docs.test.ts`) must pass.
- `docs/architecture.md` is generated in part by `scripts/gen-architecture.mjs`: run it only if the file says to.

## Acceptance criteria

- [ ] Each claim added to the architecture doc is true of the merged code (the agent lists, in Comments, the file and symbol each number and switch came from).
- [ ] The pipeline graph has the radar node with its live knobs; `pnpm test:fast` passes for `pipeline-graph.test.ts` and `pipeline-docs.test.ts`.
- [ ] Invariant 5 names the radar's public-API reads and still says argus holds no wallet and never deploys tokens (the stage B part only if tickets 10 to 12 have merged).
- [ ] The architecture doc states the X API (stage B) only if its tickets have merged; otherwise it says nothing about it.
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- Follow `docs/agents/worker-rules.md`. Docs only plus the graph data file; no behaviour change.
- Commit subject `Trend radar ticket 08: architecture doc and pipeline graph lines`, body ends with `Ticket: .scratch/trend-radar/issues/08-architecture-and-pipeline-lines.md`. No `Closes #N`.

## Comments
