# 13: Launch handoff and mark launched
**Model:** sonnet / medium — a handoff to another app plus one recorded action.

**What to build:** For a `built` Proposal, Launch opens newpairspam's token form prefilled with name, ticker, description, logo (the template SVG placeholder) and the preview link. The Operator launches in newpairspam, comes back, and marks the Proposal launched, recording the mint. Argus never touches a chain (ADR 0002).

**Blocked by:** Phase 1 ticket 07 (Build Runner happy path)

**Status:** ready-for-agent

- [ ] The prefill mechanism of newpairspam's token form (query params or pasted JSON) is determined and recorded; any newpairspam change it needs is listed and made only with the Operator's yes
- [ ] Launch is enabled only in `built`
- [ ] Mark launched records the mint address (format validated) through the lifecycle
- [ ] No wallet, chain or pump.fun call exists in argus (ADR 0002), enforced by a test
- [ ] Endpoint-level tests with the exact UI payload
- [ ] `pnpm check` passes
