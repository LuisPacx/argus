# 09: needs-human routing
**Model:** sonnet / medium — maps one documented marker to a status.

**What to build:** When a Spec needs an on-chain program, or anything not buildable unattended as a Workers web app, the Build ends in `needs-human` instead of failing or retrying, and the card says why.

**Blocked by:** 07

**Status:** ready-for-agent

- [x] The runner detects the template skill's needs-human marker (ticket 06) in the stream and sets `needs-human` from `building`, with the reason on the card
- [x] `needs-human` does not trigger the retry
- [x] Both §3 entry points work: from `building` via the marker, and from `approved` via a check before spawning; the chosen pre-spawn check is recorded under Comments
- [x] Tested with the fake `claude` emitting the marker
- [x] The marker is read only from the last line of the final stream-json `result` event's `result` text (format documented in the template README), never from other events, because the marker text also appears in tool results; a test where the marker appears only inside a tool-result event does not route to `needs-human`
- [x] `pnpm check` passes
- [x] A Spec whose first line is `## Needs human` (accepted by ticket 04's Spec validation) moves the Proposal to `needs-human` and is never built; tested

## Comments

- Pre-spawn check (from `approved`): `runNextBuild` reads the Spec file of the next approved Proposal before the preflight and before the slot is taken; if its first line is `## Needs human` (same test as `specProblem`, ticket 04) it moves the Proposal approved -> needs-human with the Spec text as the reason. No run row, clone, repo, container or claude. Dry-run mode only logs and is unchanged.
- Marker path (from `building`): already in `classifyFinalMessage` from ticket 07; it now uses a fixed prefix plus JSON checked against a strict shape, with no regex (standards rule 13). It only ever sees `run.output`, the final `result` event text; a tool-result-only marker is tested.
