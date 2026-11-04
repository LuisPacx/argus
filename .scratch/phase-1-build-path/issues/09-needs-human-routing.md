# 09: needs-human routing
**Model:** sonnet / medium — maps one documented marker to a status.

**What to build:** When a Spec needs an on-chain program, or anything not buildable unattended as a Workers web app, the Build ends in `needs-human` instead of failing or retrying, and the card says why.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] The runner detects the template skill's needs-human marker (ticket 06) in the stream and sets `needs-human` from `building`, with the reason on the card
- [ ] `needs-human` does not trigger the retry
- [ ] Both §3 entry points work: from `building` via the marker, and from `approved` via a check before spawning; the chosen pre-spawn check is recorded under Comments
- [ ] Tested with the fake `claude` emitting the marker
- [ ] `pnpm check` passes
