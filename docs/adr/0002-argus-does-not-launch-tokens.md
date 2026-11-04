# Argus does not launch tokens: the newpairspam boundary

Argus researches, proposes, specs and builds. Token deploy, trading and PnL stay in newpairspam. The handoff is a Launch button that opens the newpairspam token form prefilled from the Proposal (name, ticker, description, logo, preview link), and a manual "mark launched" in the War Room where the Operator records the mint. Argus holds no wallet and no chain keys.

## Considered Options

- **Embed deploy in argus**: one tool end to end, but it puts wallet keys and spend authority into an agent-driven system that spawns unattended builds, and duplicates what newpairspam already does well.
- **Webhook or API back from newpairspam**: removes the manual "mark launched" step, but couples two deployables and needs auth between them; the manual step is a deliberate human gate. Auto-launch through a newpairspam API is explicitly out of scope, including in phase 3.
- **Fork helios (which has its own launcher)**: rejected earlier in favor of a new repo that reuses helios seams only.

## Consequences

- The only coupling is the prefill format. Whether it is query params or a JSON paste is an open question to check in newpairspam's `TokenForm.vue` before building the button.
- Launch status in argus is only as accurate as the Operator's "mark launched"; outcome tracking (phase 3) is entered by hand too.
- The old plan's generator, deployer, promoter, position manager and ledger are out of scope for this repo.
