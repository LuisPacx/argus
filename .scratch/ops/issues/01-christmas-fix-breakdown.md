# OK the Christmas fix ticket breakdown

Status: in-progress
6 planned tickets: 1 term module, 2 stabiliser, 3 wire, 4 blend pass, 5 UI note + ADR, 6 live check; AI term seeds dropped by default.
Plan: "Christmas plan" entry in .scratch/cos.md (or its archive). After Luis's OK: he types /to-tickets, then dispatch tickets 1 and 2. GM/01 "live tick shows Christmas as a Meta" box stays open until ticket 6.
Running: argus worker pid 4185296 (runs a503eb8).

## Comments
- 2026-11-22 17:07 [d37fa1ed] Luis OK'd 2026-11-22 (6 tickets, no AI seeds). Sonnet worker writing .scratch/christmas-fix/issues/01-06; then dispatch 01 and 02 in own worktrees under ~/.cache/argus-scratch/.
- 2026-11-22 17:09 [d37fa1ed] Tickets c706ec6. 02 running (sonnet high, branch christmas-02, ~/.cache/argus-scratch/christmas-02). 01 queued until the hermes-ct PumpSwap worker finishes (2-suite cap).
- 2026-11-22 17:16 [d37fa1ed] 01 dispatched (sonnet medium, branch christmas-01, ~/.cache/argus-scratch/christmas-01). 02 still running.
- 2026-11-22 17:26 [d37fa1ed] 02 at 26367c0 (christmas-02), 01 at 7b7f2e5 (christmas-01), both on 0a6df3a; verifier+reviewer running on each. Whichever merges second needs a rebase by a worker before ff.
- 2026-11-22 17:27 [d37fa1ed] Reviews: 01 MERGE, 02 MERGE (02's risks for 03 noted on ticket 03). Verifiers still running.
