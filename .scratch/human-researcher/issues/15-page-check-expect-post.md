# 15: page:check can expect a blocked POST, to prove keyboard activation
**Model:** sonnet / medium — a small tool change with a few edge cases.

**What to build:** `pnpm page:check` aborts every non-GET/HEAD request and fails the run, so a keys run that presses Enter on a button that POSTs (Withdraw on /research, ticket 10) exits 1 even though that POST is exactly the proof that Enter works. Add a repeatable `--expect-post <path>` option (a path on the checked server; a `*` stands for one path segment, e.g. `/api/picks/*/withdraw`). A non-GET request to a matching path is still NOT sent to the server (it is answered with a harmless stub, so no data changes), is recorded, printed as `expected POST seen: <method> <path>`, and does not fail the run. A run given `--expect-post` where no such request happens fails (that is the proof the keys work). Any other non-GET request still fails as today. The worker rules and the usage text name the flag.

**Blocked by:** none

Status: done

- [x] A non-GET request matching an `--expect-post` path is never sent to the server, is reported as `expected POST seen: <method> <path>` and does not fail the run (browser test with a counting server).
- [x] A run with `--expect-post` where the request never happens exits 1 and says which path was not seen (tests).
- [x] A non-GET request to any other path still fails the run with "blocked <method>" (test); the option is repeatable and `*` matches one segment only (tests).
- [x] The JSON summary lists the expected and the seen requests.
- [x] Proof on the real case: a seeded keys run on /research that presses Withdraw exits 0 with `--expect-post` for the withdraw route and exits 1 without it.
- [x] The worker rules and the usage text document the flag.
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments

- 2026-11-21 cos: reviewer SHIP, verifier PASS on e6a20fd (238/3791, 4 new tests fail on parent, /research with flag exit 0, without exit 1).
